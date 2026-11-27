<?php
declare(strict_types=1);
namespace StepDoc;

/** Installation-only protocol. All normal app operations retain Storage API v1. */
final class Installer
{
    private readonly string $root;
    private readonly string $base;
    private readonly string $origin;
    private readonly string $keyHash;
    public function __construct()
    {
        $this->root = dirname(__DIR__);
        $installed = Config::installed();
        $api = getenv('STEPDOC_API_PATH') ?: ($installed['apiPath'] ?? null);
        if ($api !== null && !preg_match('~^/(?:[a-zA-Z0-9_-]+/)*api/v1$~D', $api)) throw new ApiError('invalid_options', 503);
        $directory = str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/index.php'));
        $this->base = $api !== null ? substr($api, 0, -strlen('/api/v1')) : ($directory === '/' || $directory === '.' ? '' : $directory);
        if (!preg_match('~^(?:/[a-zA-Z0-9_-]+)*$~D', $this->base)) throw new ApiError('invalid_options', 503);
        $host = $_SERVER['HTTP_HOST'] ?? '';
        if (!preg_match('~^[A-Za-z0-9.\-:\[\]]{1,260}$~D', $host)) throw new ApiError('invalid_options', 503);
        $this->origin = (($_SERVER['HTTPS'] ?? '') === 'on' ? 'https://' : 'http://') . strtolower($host);
        $hash = trim((string) file_get_contents($this->root . '/setup-key.sha256'));
        if (!preg_match('~^[a-f0-9]{64}$~D', $hash)) throw new ApiError('invalid_options', 503);
        $this->keyHash = $hash;
    }
    public static function intercept(): void
    {
        if (!is_file(__DIR__ . '/../setup-key.sha256')) return;
        $self = new self();
        $path = parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH);
        if ($path === $self->base . '/install.php' && isset($_GET['action'])) $self->run();
        if ($path === $self->base . '/install.php') { header('Location: ' . $self->base . '/setup', true, 303); exit; }
        if ($path === $self->base . '/browser' || (is_string($path) && str_starts_with($path, $self->base . '/browser/'))) {
            ClientApp::serve($self->appDir(), $self->base . '/browser', ['stepdoc-base' => $self->base . '/browser']);
        }
        if (!$self->complete()) {
            ClientApp::serve($self->appDir(), $self->base, ['stepdoc-api' => $self->base . '/api/v1/', 'stepdoc-install' => $self->base . '/install.php']);
        }
    }
    private function appDir(): string
    {
        return getenv('STEPDOC_APP_DIR') ?: $this->root . '/app';
    }
    private function database(): Database
    {
        return new Database(new Config());
    }
    private function complete(): bool
    {
        if (!is_file($this->root . '/stepdoc.config.json')) return false;
        $db = $this->database();
        $row = $db->one('SELECT * FROM installation WHERE id=1');
        if (!$row) return $db->one('SELECT id FROM members LIMIT 1') !== null;
        if ($row['completed_at'] !== null) return true;
        if (!$row['member_id'] && $db->one('SELECT id FROM members LIMIT 1')) return true;
        // Repair an interrupted response after verified WebAuthn committed.
        if ($row['member_id'] && $db->one('SELECT id FROM passkeys WHERE member_id=? LIMIT 1', [$row['member_id']])) {
            $db->transaction(function () use ($db, $row): void {
                if ($row['token_id']) (new Tokens($db))->revoke($row['token_id'], 'installer');
                $db->execute('UPDATE installation SET completed_at=?,expires_at=0 WHERE id=1', [Database::now()]);
            });
            return true;
        }
        return false;
    }
    private function checks(): array
    {
        $host = trim((string) parse_url($this->origin, PHP_URL_HOST), '[]');
        $local = $host === 'localhost';
        $tls = str_starts_with($this->origin, 'https://');
        $data = getenv('STEPDOC_DATA_DIR') ?: $this->root . '/data';
        $parent = realpath(is_dir($data) ? $data : dirname($data));
        $public = realpath($this->root . '/public');
        $documentRoot = realpath($_SERVER['DOCUMENT_ROOT'] ?? $this->root . '/public');
        $private = $parent && $public && $documentRoot && !Config::inside($parent, $public) && !Config::inside($parent, $documentRoot) && !Config::inside($this->root, $documentRoot);
        $upload = min(64 * 1024 * 1024, Config::iniBytes('upload_max_filesize'), max(1, Config::iniBytes('post_max_size') - 65536));
        return [
            ['id' => 'php', 'status' => PHP_VERSION_ID >= 80100 ? 'ok' : 'error', 'message' => 'PHP ' . PHP_MAJOR_VERSION . '.' . PHP_MINOR_VERSION],
            ['id' => 'sqlite', 'status' => class_exists(\PDO::class) && in_array('sqlite', \PDO::getAvailableDrivers(), true) ? 'ok' : 'error', 'message' => 'pdo_sqlite'],
            ['id' => 'openssl', 'status' => extension_loaded('openssl') ? 'ok' : 'error', 'message' => 'OpenSSL'],
            ['id' => 'https', 'status' => $tls ? 'ok' : ($local ? 'warn' : 'error'), 'message' => $tls ? 'HTTPS' : ($local ? 'Localhost HTTP' : 'HTTPS required')],
            ['id' => 'passkeys', 'status' => $host !== '' && filter_var($host, FILTER_VALIDATE_IP) === false ? 'ok' : 'error', 'message' => 'Passkey hostname'],
            ['id' => 'private-storage', 'status' => $private && is_writable($parent) && is_writable($this->root) ? 'ok' : 'error', 'message' => $private ? 'Storage outside webroot' : 'Set document root to public/'],
            ['id' => 'upload', 'status' => $upload >= 1048576 ? 'ok' : 'warn', 'message' => 'upload_max ' . (string) round($upload / 1048576, 1) . 'M'],
            ['id' => 'email', 'status' => (new Mailer())->enabled() ? 'ok' : 'warn', 'message' => (new Mailer())->enabled() ? 'SMTP codes configured' : 'mail() off → SMTP for codes'],
        ];
    }
    private function principal(Database $db, AuthState $auth): array
    {
        $cookie = AuthState::cookie('sd_install');
        $row = $db->one('SELECT * FROM installation WHERE id=1 AND completed_at IS NULL AND expires_at>?', [time()]);
        if (!$cookie || !$row || !hash_equals($row['key_hash'], $this->keyHash) || !hash_equals($row['session_hash'], $auth->hash('installation', $cookie))) throw new ApiError('unauthorized', 401);
        return $row;
    }
    private function status(): array
    {
        $checks = $this->checks();
        $status = ['phase' => $this->complete() ? 'complete' : 'storage', 'base' => $this->base, 'checks' => $checks, 'ready' => !array_filter($checks, static fn(array $item): bool => $item['status'] === 'error')];
        if ($status['phase'] === 'storage' && is_file($this->root . '/stepdoc.config.json')) {
            $db = $this->database();
            try {
                $row = $this->principal($db, new AuthState($db));
                $status['phase'] = 'owner';
                if ($row['member_id']) {
                    $member = $db->one('SELECT name,email FROM members WHERE id=?', [$row['member_id']]);
                    $workspace = $db->one('SELECT name FROM workspaces WHERE id=?', [$row['workspace_id']]);
                    $status['owner'] = ['name' => $member['name'], 'email' => $member['email'], 'workspace' => $workspace['name']];
                }
            } catch (ApiError $error) { if ($error->status !== 401) throw $error; }
        }
        return $status;
    }
    private function body(): mixed
    {
        if (strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0])) !== 'application/json') throw new ApiError('unsupported_media_type', 415);
        if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 131072) throw new ApiError('upload_too_large', 413);
        $body = file_get_contents('php://input', false, null, 0, 131073);
        if ($body === false || strlen($body) > 131072) throw new ApiError('upload_too_large', 413);
        try { return json_decode($body, false, 32, JSON_THROW_ON_ERROR); }
        catch (\JsonException) { throw new ApiError('invalid_options'); }
    }
    private function writeConfig(): void
    {
        $path = $this->root . '/stepdoc.config.json';
        $settings = ['origin' => $this->origin, 'apiPath' => $this->base . '/api/v1'];
        if (is_file($path)) {
            if (Config::installed() !== $settings) throw new ApiError('invalid_options', 409);
            return;
        }
        $temporary = $this->root . '/.install-' . bin2hex(random_bytes(8));
        $mask = umask(0077);
        try {
            if (file_put_contents($temporary, json_encode($settings, JSON_THROW_ON_ERROR), LOCK_EX) === false || !rename($temporary, $path)) throw new ApiError('storage_unavailable', 503);
        } finally { umask($mask); if (is_file($temporary)) unlink($temporary); }
    }
    private function claim(mixed $input): array
    {
        $body = AuthState::object($input, ['key'], ['key']);
        if (!is_string($body->key) || !preg_match('~^[A-Za-z0-9_-]{43}$~D', $body->key) || !hash_equals($this->keyHash, hash('sha256', $body->key))) throw new ApiError('unauthorized', 401);
        if (array_filter($this->checks(), static fn(array $check): bool => $check['status'] === 'error')) throw new ApiError('storage_unavailable', 503);
        $this->writeConfig();
        $db = $this->database(); $auth = new AuthState($db);
        $raw = AuthState::random(); $expires = time() + 600;
        $db->transaction(function () use ($db, $auth, $raw, $expires): void {
            $old = $db->one('SELECT * FROM installation WHERE id=1');
            if (($old && ($old['completed_at'] !== null || !hash_equals($old['key_hash'], $this->keyHash))) || (!$old && $db->one('SELECT id FROM members LIMIT 1'))) throw new ApiError('conflict', 409);
            if ($old && $old['token_id']) (new Tokens($db))->revoke($old['token_id'], 'installer');
            $db->execute('INSERT INTO installation(id,key_hash,session_hash,expires_at) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET session_hash=excluded.session_hash,expires_at=excluded.expires_at,token_id=NULL', [$this->keyHash, $auth->hash('installation', $raw), $expires]);
        });
        $auth->setCookie('sd_install', $raw, $expires);
        $_COOKIE['sd_install'] = $raw;
        return $this->status();
    }
    private function ownerOptions(mixed $input): object
    {
        $body = AuthState::object($input, ['name', 'email', 'workspace'], ['name', 'email', 'workspace']);
        $email = AuthState::email($body->email);
        if (!is_string($body->name) || !trim($body->name) || strlen($body->name) > 120 || !is_string($body->workspace) || !trim($body->workspace) || strlen($body->workspace) > 200) throw new ApiError('invalid_options');
        $db = $this->database(); $auth = new AuthState($db); $tokens = new Tokens($db);
        $sessions = new Sessions($db, $auth, $tokens);
        $row = $this->principal($db, $auth);
        $db->transaction(function () use ($db, $sessions, $body, $email, $row): void {
            if ($row['member_id']) {
                $member = $db->one('SELECT name,email FROM members WHERE id=?', [$row['member_id']]);
                $workspace = $db->one('SELECT name FROM workspaces WHERE id=?', [$row['workspace_id']]);
                if ($member['name'] !== trim($body->name) || $member['email'] !== $email || $workspace['name'] !== trim($body->workspace)) throw new ApiError('conflict', 409);
            } else {
                if ($db->one('SELECT id FROM members LIMIT 1')) throw new ApiError('conflict', 409);
                $id = Database::id();
                $db->execute('INSERT INTO workspaces VALUES(?,?,?,?)', [$id, trim($body->workspace), '{}', Database::now()]);
                $member = $sessions->addMember($id, $body->name, $email, 'owner', true);
                $db->execute('UPDATE installation SET workspace_id=?,member_id=? WHERE id=1', [$id, $member['id']]);
            }
            if (!$row['token_id']) {
                $current = $db->one('SELECT * FROM installation WHERE id=1');
                $id = Database::id();
                $db->execute('INSERT INTO tokens(id,workspace_id,name,kind,token_hash,scopes,expires_at) VALUES(?,?,?,?,?,?,?)', [$id, $current['workspace_id'], 'Initial owner enrollment', 'token', hash('sha256', 'sd_' . AuthState::cookie('sd_install')), '["admin"]', $current['expires_at']]);
                $db->execute('UPDATE installation SET token_id=? WHERE id=1', [$id]);
                $db->audit($current['workspace_id'], 'installer', 'installation.enroll', $id);
            }
        });
        return $this->withBootstrap(fn() => (new Passkeys($db, $auth, $sessions))->options((object) ['mode' => 'register', 'email' => $email]));
    }
    private function verify(mixed $input): array
    {
        $db = $this->database(); $auth = new AuthState($db); $tokens = new Tokens($db);
        $this->principal($db, $auth);
        $result = $this->withBootstrap(fn() => (new Passkeys($db, $auth, new Sessions($db, $auth, $tokens)))->verify($input));
        if (!$this->complete()) throw new ApiError('storage_unavailable', 503);
        $auth->setCookie('sd_install', '', 1);
        return $result;
    }
    private function withBootstrap(callable $work): mixed
    {
        $_SERVER['HTTP_AUTHORIZATION'] = 'Bearer sd_' . AuthState::cookie('sd_install');
        try { return $work(); }
        finally { unset($_SERVER['HTTP_AUTHORIZATION']); }
    }
    private function run(): never
    {
        $action = $_GET['action']; $method = $_SERVER['REQUEST_METHOD'];
        if (count($_GET) !== 1 || !is_string($action) || !in_array($action, ['status', 'claim', 'owner-options', 'owner-verify'], true)) throw new ApiError('not_found', 404);
        if ($action === 'status') {
            if ($method !== 'GET') { header('Allow: GET'); throw new ApiError('method_not_allowed', 405); }
            Application::json($this->status());
        }
        if ($method !== 'POST') { header('Allow: POST'); throw new ApiError('method_not_allowed', 405); }
        if (($_SERVER['HTTP_ORIGIN'] ?? '') !== $this->origin || isset($_SERVER['HTTP_AUTHORIZATION'])) throw new ApiError('forbidden', 403);
        $body = $this->body();
        $mask = umask(0077);
        try { $lock = fopen($this->root . '/installation.lock', 'c+b'); }
        finally { umask($mask); }
        if (!$lock || !flock($lock, LOCK_EX)) throw new ApiError('storage_unavailable', 503);
        try {
            if ($this->complete()) throw new ApiError('conflict', 409);
            if ($action !== 'claim' && !is_file($this->root . '/stepdoc.config.json')) throw new ApiError('unauthorized', 401);
            $result = match ($action) { 'claim' => $this->claim($body), 'owner-options' => $this->ownerOptions($body), 'owner-verify' => $this->verify($body) };
        } finally { flock($lock, LOCK_UN); fclose($lock); }
        Application::json($result);
    }
}
