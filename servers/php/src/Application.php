<?php
declare(strict_types=1);
namespace StepDoc;

final class Application
{
    private readonly Tokens $tokens;
    private readonly Guides $guides;
    private readonly Blobs $blobs;
    private readonly AuthState $authState;
    private readonly Sessions $sessions;
    private readonly Passkeys $passkeys;
    private readonly SignInCodes $codes;
    private readonly Mailer $mailer;
    private readonly Devices $devices;
    public function __construct(private readonly Database $db)
    {
        $this->tokens = new Tokens($db);
        $this->guides = new Guides($db, new GuideValidator());
        $this->blobs = new Blobs($db, $this->guides);
        $this->authState = new AuthState($db);
        $this->sessions = new Sessions($db, $this->authState, $this->tokens);
        $this->passkeys = new Passkeys($db, $this->authState, $this->sessions);
        $this->mailer = new Mailer();
        $this->codes = new SignInCodes($db, $this->authState, $this->sessions, $this->mailer);
        $this->devices = new Devices($db, $this->authState, $this->tokens);
    }
    public static function headers(): void
    {
        header('Cache-Control: no-store');
        header('X-Content-Type-Options: nosniff');
        header('Referrer-Policy: no-referrer');
        header("Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
        if (($_SERVER['HTTPS'] ?? '') === 'on') header('Strict-Transport-Security: max-age=31536000');
    }
    public static function json(mixed $value, int $status = 200): never
    {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        exit;
    }
    private function cors(string $relative): void
    {
        $origin = $_SERVER['HTTP_ORIGIN'] ?? null;
        header('Vary: Origin');
        if ($origin !== null) {
            // Only the anonymous enrollment exchange can introduce a new extension origin.
            $enrollment = $relative === 'pairing/claim' && Tokens::extensionOrigin($origin);
            if ($origin !== $this->db->config->origin && !$enrollment && !$this->tokens->allowsOrigin($origin)) throw new ApiError('forbidden', 403);
            header('Access-Control-Allow-Origin: ' . $origin);
            if ($origin === $this->db->config->origin) header('Access-Control-Allow-Credentials: true');
            header('Access-Control-Expose-Headers: ETag, Content-Type, Content-Length');
        }
        if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
            if ($origin === null || !in_array($_SERVER['HTTP_ACCESS_CONTROL_REQUEST_METHOD'] ?? '', ['GET', 'POST', 'PUT', 'DELETE'], true)) throw new ApiError('forbidden', 403);
            $headers = strtolower($_SERVER['HTTP_ACCESS_CONTROL_REQUEST_HEADERS'] ?? '');
            foreach (explode(',', $headers) as $header) if (trim($header) !== '' && !in_array(trim($header), ['authorization', 'content-type', 'if-match'], true)) throw new ApiError('forbidden', 403);
            header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE');
            header('Access-Control-Allow-Headers: Authorization, Content-Type, If-Match');
            header('Access-Control-Max-Age: 600');
            http_response_code(204);
            exit;
        }
    }
    private function body(): mixed
    {
        if (strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0])) !== 'application/json') throw new ApiError('unsupported_media_type', 415);
        if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > $this->db->config->maxJsonBytes) throw new ApiError('upload_too_large', 413);
        $stream = fopen('php://input', 'rb');
        $body = stream_get_contents($stream, $this->db->config->maxJsonBytes + 1);
        fclose($stream);
        if ($body === false || strlen($body) > $this->db->config->maxJsonBytes) throw new ApiError('upload_too_large', 413);
        try { return json_decode($body, false, 512, JSON_THROW_ON_ERROR); }
        catch (\JsonException) { throw new ApiError('invalid_guide'); }
    }
    public function run(): never
    {
        $path = parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH);
        $base = $this->db->config->apiPath;
        if (!is_string($path) || !str_starts_with($path, $base . '/') || preg_match('~%(?:2f|5c|00)~i', $path)) throw new ApiError('not_found', 404);
        $relative = rawurldecode(substr($path, strlen($base) + 1));
        if (str_contains($relative, '\\') || str_contains($relative, "\0")) throw new ApiError('not_found', 404);
        $this->cors($relative);
        $method = $_SERVER['REQUEST_METHOD'];
        if ($relative === 'health') {
            if ($method !== 'GET') throw new ApiError('method_not_allowed', 405);
            self::json(['target' => 'php-sqlite', 'version' => '2.0.0-dev', 'schema' => 'stepdoc/guide@1', 'capabilities' => ['members' => false, 'passkeys' => $this->passkeys->available(), 'emailCodes' => $this->mailer->enabled(), 'publicLinks' => false, 'githubPages' => false, 'mcp' => false, 'maxUploadBytes' => $this->db->config->maxUploadBytes], 'checks' => [['id' => 'sqlite', 'status' => 'ok', 'message' => 'SQLite storage is available.'], ['id' => 'private-storage', 'status' => 'ok', 'message' => 'Data and blobs are outside the web root.'], ['id' => 'sign-in', 'status' => 'warn', 'message' => 'Passkey, recovery and configured email sign-in are available. Initial owner enrollment uses local administration; the setup UI and installer remain unfinished.']]]);
        }
        if ($relative === 'auth/session') {
            if ($method !== 'GET') throw new ApiError('method_not_allowed', 405);
            self::json($this->sessions->current());
        }
        if (in_array($relative, ['auth/passkey/options', 'auth/passkey/verify', 'auth/code/request', 'auth/code/verify', 'auth/recovery', 'auth/logout', 'pairing/claim'], true)) {
            if ($method !== 'POST') throw new ApiError('method_not_allowed', 405);
            if ($relative === 'auth/logout') { $this->sessions->logout(); http_response_code(204); exit; }
            $body = $this->body();
            if ($relative === 'auth/passkey/options') self::json($this->passkeys->options($body));
            if ($relative === 'auth/passkey/verify') self::json($this->passkeys->verify($body));
            if ($relative === 'auth/code/request') { $this->codes->request($body); self::json(['accepted' => true], 202); }
            if ($relative === 'auth/code/verify') self::json($this->codes->verify($body));
            if ($relative === 'auth/recovery') self::json($this->codes->verify($body, true));
            if ($relative === 'pairing/claim') self::json($this->devices->claim($body), 201);
        }
        $token = $this->sessions->authenticate();
        $workspace = $token['workspace_id'];
        if ($relative === 'pairing/codes') {
            if ($method !== 'POST') throw new ApiError('method_not_allowed', 405);
            self::json($this->devices->code($token), 201);
        }
        if ($relative === 'tokens') {
            if ($method !== 'POST') throw new ApiError('method_not_allowed', 405);
            self::json($this->devices->issue($token, $this->body()), 201);
        }
        if ($relative === 'devices') {
            if ($method !== 'GET') throw new ApiError('method_not_allowed', 405);
            self::json($this->devices->list($token));
        }
        if (preg_match('~^devices/([^/]+)$~D', $relative, $match)) {
            if ($method !== 'DELETE') throw new ApiError('method_not_allowed', 405);
            $this->devices->revoke($token, $match[1]); http_response_code(204); exit;
        }
        if ($relative === 'guides') {
            if ($method === 'GET') { Tokens::requireScope($token, 'guides:read'); self::json($this->guides->list($workspace, $_GET)); }
            if ($method === 'POST') { Tokens::requireScope($token, 'guides:write'); self::json($this->guides->create($token, $this->body()), 201); }
            throw new ApiError('method_not_allowed', 405);
        }
        if (preg_match('~^guides/([^/]+)(?:/(versions|blobs)(?:/([^/]+))?)?$~D', $relative, $match)) {
            $id = $match[1]; $operation = $match[2] ?? ''; $version = $match[3] ?? '';
            Guides::id($id);
            if ($operation === '') {
                if ($method === 'GET') { Tokens::requireScope($token, 'guides:read'); $guide = $this->guides->get($workspace, $id); header('ETag: "' . $guide->version . '"'); self::json($guide); }
                if ($method === 'PUT') { Tokens::requireScope($token, 'guides:write'); $guide = $this->guides->save($token, $id, $this->body(), $_SERVER['HTTP_IF_MATCH'] ?? null); header('ETag: "' . $guide->version . '"'); self::json($guide); }
                if ($method === 'DELETE') { Tokens::requireScope($token, 'guides:write'); $this->guides->delete($token, $id); http_response_code(204); exit; }
            }
            if ($operation === 'versions' && $method === 'GET') {
                Tokens::requireScope($token, 'guides:read');
                self::json($version !== '' ? $this->guides->historical($workspace, $id, $version) : $this->guides->versions($workspace, $id));
            }
            if ($operation === 'blobs' && $version === '' && $method === 'POST') {
                Tokens::requireScope($token, 'guides:write');
                if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > $this->db->config->maxUploadBytes + 65536) throw new ApiError('upload_too_large', 413);
                self::json($this->blobs->put($token, $id, $_POST, $_FILES), 201);
            }
            throw new ApiError('method_not_allowed', 405);
        }
        if (preg_match('~^blobs/([^/]+)$~D', $relative, $match)) {
            if ($method !== 'GET') throw new ApiError('method_not_allowed', 405);
            Tokens::requireScope($token, 'guides:read');
            $blob = $this->blobs->get($workspace, $match[1]);
            header('Content-Type: ' . $blob['mime']);
            header('Content-Length: ' . $blob['bytes']);
            header('ETag: "' . $blob['sha256'] . '"');
            readfile($blob['path']);
            exit;
        }
        throw new ApiError('not_found', 404);
    }
}
