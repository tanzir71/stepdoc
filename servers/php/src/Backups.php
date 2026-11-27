<?php
declare(strict_types=1);
namespace StepDoc;

/** Private daily recovery points. Images are copied as bytes, never decoded. */
final class Backups
{
    private const FORMAT = 'stepdoc/php-backup@1';
    private const KEEP = 7;
    private const RETRY = 300;
    private readonly \DateTimeImmutable $now;
    public function __construct(private readonly Database $db, ?\DateTimeImmutable $now = null)
    {
        $this->now = ($now ?? new \DateTimeImmutable('now'))->setTimezone(new \DateTimeZone('UTC'));
    }
    private static function id(mixed $id): bool
    {
        if (!is_string($id) || !preg_match('~^\d{4}-\d{2}-\d{2}T\d{6}Z-[a-f0-9]{16}$~D', $id)) return false;
        $date = \DateTimeImmutable::createFromFormat('!Y-m-d\THis\Z', substr($id, 0, 18), new \DateTimeZone('UTC'));
        return $date && $date->format('Y-m-d\THis\Z') === substr($id, 0, 18);
    }
    private static function samePath(string $a, string $b): bool
    {
        $a = str_replace('\\', '/', $a); $b = str_replace('\\', '/', $b);
        return PHP_OS_FAMILY === 'Windows' ? strtolower($a) === strtolower($b) : $a === $b;
    }
    private function root(bool $create = false): string
    {
        $path = $this->db->config->dataDir . '/backups';
        // Long-lived PHP workers cache realpaths across external directory swaps.
        clearstatcache(true);
        if (is_link($path)) throw new ApiError('storage_unavailable', 503);
        if ($create && !file_exists($path) && !@mkdir($path, 0700) && !is_dir($path)) throw new ApiError('storage_unavailable', 503);
        $real = realpath($path);
        if (is_link($path) || ($real !== false && !self::samePath($real, $path))) throw new ApiError('storage_unavailable', 503);
        if ($create && (!$real || !is_dir($real))) throw new ApiError('storage_unavailable', 503);
        return $real ?: $path;
    }
    private static function jsonLine(array $value): string
    {
        return json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES) . "\n";
    }
    private static function write($file, string $bytes): void
    {
        for ($offset = 0; $offset < strlen($bytes);) {
            $written = @fwrite($file, substr($bytes, $offset));
            if ($written === false || $written === 0) throw new ApiError('storage_unavailable', 503);
            $offset += $written;
        }
    }
    private static function sync($file): void
    {
        if (!@fflush($file) || !@fsync($file)) throw new ApiError('storage_unavailable', 503);
    }
    private static function newFile(string $path)
    {
        // Expected I/O failures become fixed errors; host paths stay out of CLI output.
        $mask = umask(0077);
        try { $file = @fopen($path, 'xb'); }
        finally { umask($mask); }
        if (!$file) throw new ApiError('storage_unavailable', 503);
        return $file;
    }
    private static function record(string $directory, string $relative): array
    {
        $bytes = @filesize($directory . '/' . $relative);
        $hash = @hash_file('sha256', $directory . '/' . $relative);
        if ($bytes === false || $hash === false) throw new ApiError('storage_unavailable', 503);
        return ['path' => $relative, 'bytes' => $bytes, 'sha256' => $hash];
    }
    private function state(string $root): array
    {
        $path = $root . '/.status.json';
        if (!is_file($path) || is_link($path) || filesize($path) > 4096) return [];
        try { $state = json_decode(file_get_contents($path), true, 8, JSON_THROW_ON_ERROR); }
        catch (\Throwable) { return []; }
        return is_array($state) && is_int($state['attemptedAt'] ?? null) && is_bool($state['failed'] ?? null) ? $state : [];
    }
    private function writeState(string $root, array $state): void
    {
        if (is_link($root . '/.status.json')) throw new ApiError('storage_unavailable', 503);
        $path = $root . '/.state-' . bin2hex(random_bytes(8));
        $file = self::newFile($path);
        try {
            self::write($file, self::jsonLine($state)); self::sync($file);
            fclose($file); $file = null;
            if (!@rename($path, $root . '/.status.json')) throw new ApiError('storage_unavailable', 503);
        } finally {
            if (is_resource($file)) fclose($file);
            if (is_file($path)) unlink($path);
        }
    }
    private function lock(string $root, bool $exclusive)
    {
        $path = $root . '/.lock';
        if (is_link($path)) throw new ApiError('storage_unavailable', 503);
        $mask = umask(0077);
        try { $file = @fopen($path, 'c+b'); }
        finally { umask($mask); }
        if (!$file) throw new ApiError('storage_unavailable', 503);
        if (!flock($file, ($exclusive ? LOCK_EX : LOCK_SH) | LOCK_NB)) { fclose($file); return null; }
        return $file;
    }
    private function current(string $root, array $state): bool
    {
        $id = $state['id'] ?? null;
        return self::id($id) && !$state['failed'] && substr($id, 0, 10) >= $this->now->format('Y-m-d') && is_file($root . '/' . $id . '/manifest.jsonl') && !is_link($root . '/' . $id);
    }
    public function check(): array
    {
        try {
            $root = $this->root(); $state = $this->state($root);
            if ($state && $this->current($root, $state)) return ['id' => 'backup', 'status' => 'ok', 'message' => 'Daily private backup completed.'];
        } catch (\Throwable) {}
        return ['id' => 'backup', 'status' => 'warn', 'message' => 'Daily backup is pending or unavailable; check local backup commands.'];
    }
    public function daily(): void
    {
        // Backup failures never replace an application's response or mutate live data.
        try { $this->run(false); } catch (\Throwable) {}
    }
    public function create(): array
    {
        return $this->run(true) ?? throw new ApiError('storage_unavailable', 503);
    }
    private function run(bool $manual): ?array
    {
        if (!$this->db->one('SELECT id FROM workspaces LIMIT 1')) return null;
        $root = $this->root(true); $state = $this->state($root);
        if (!$manual && ($this->current($root, $state) || ($state && $state['failed'] && $this->now->getTimestamp() - $state['attemptedAt'] < self::RETRY))) return null;
        $lock = $this->lock($root, true);
        if (!$lock) { if ($manual) throw new ApiError('storage_unavailable', 503); return null; }
        $stage = null;
        try {
            $state = $this->state($root);
            if (!$manual && ($this->current($root, $state) || ($state && $state['failed'] && $this->now->getTimestamp() - $state['attemptedAt'] < self::RETRY))) return null;
            $this->writeState($root, ['attemptedAt' => $this->now->getTimestamp(), 'failed' => true, 'id' => $state['id'] ?? null]);
            foreach (new \DirectoryIterator($root) as $entry) {
                if (preg_match('~^\.pending-(.+)$~D', $entry->getFilename(), $match) && self::id($match[1])) $this->remove($root, $entry->getPathname());
                if (preg_match('~^\.state-[a-f0-9]{16}$~D', $entry->getFilename()) && $entry->isFile() && !$entry->isLink()) unlink($entry->getPathname());
            }
            // Adopt a completed rename if a process died before updating its status.
            if (!$manual) foreach ($this->list() as $summary) if (substr($summary['id'], 0, 10) >= $this->now->format('Y-m-d')) {
                try { $this->verifyFiles($root, $summary['id']); } catch (\Throwable) { continue; }
                $this->prune($root, $summary['id']);
                $this->writeState($root, ['attemptedAt' => $this->now->getTimestamp(), 'failed' => false, 'id' => $summary['id']]);
                return $summary;
            }
            $id = $this->now->format('Y-m-d\THis\Z') . '-' . bin2hex(random_bytes(8));
            $stage = $root . '/.pending-' . $id;
            if (!@mkdir($stage, 0700) || !@mkdir($stage . '/data', 0700) || !@mkdir($stage . '/data/blobs', 0700)) throw new ApiError('storage_unavailable', 503);
            $summary = $this->snapshot($stage, $id, $manual);
            if (!@rename($stage, $root . '/' . $id)) throw new ApiError('storage_unavailable', 503);
            $stage = null;
            $this->prune($root, $id);
            $this->writeState($root, ['attemptedAt' => $this->now->getTimestamp(), 'failed' => false, 'id' => $id]);
            return $summary;
        } finally {
            try { if ($stage !== null && is_dir($stage)) $this->remove($root, $stage); }
            finally { flock($lock, LOCK_UN); fclose($lock); }
        }
    }
    private function snapshot(string $stage, string $id, bool $manual): array
    {
        // VACUUM INTO includes committed WAL pages without checkpointing the live DB.
        $this->db->execute('VACUUM INTO ?', [$stage . '/data/stepdoc.sqlite']);
        $copy = new \PDO('sqlite:' . $stage . '/data/stepdoc.sqlite', null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);
        $copy->exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE; DELETE FROM capture_blobs; DELETE FROM capture_uploads WHERE committed_at IS NULL; COMMIT; VACUUM;');
        if ($copy->query('PRAGMA quick_check')->fetchColumn() !== 'ok' || $copy->query('PRAGMA foreign_key_check')->fetch() !== false) throw new ApiError('corrupt_data', 500);
        $header = ['format' => self::FORMAT, 'id' => $id, 'createdAt' => $this->now->format('Y-m-d\TH:i:s\Z'), 'kind' => $manual ? 'manual' : 'daily'];
        $manifest = self::newFile($stage . '/manifest.jsonl');
        $hash = hash_init('sha256'); $count = 0; $total = 0;
        $append = function (array $entry) use ($manifest, $hash, &$count, &$total): void {
            if ($entry['bytes'] < 0 || PHP_INT_MAX - $entry['bytes'] < $total) throw new ApiError('storage_unavailable', 503);
            $line = self::jsonLine($entry); self::write($manifest, $line); hash_update($hash, $line);
            $count++; $total += $entry['bytes'];
        };
        try {
            $line = self::jsonLine($header); self::write($manifest, $line); hash_update($hash, $line);
            $database = $stage . '/data/stepdoc.sqlite';
            $file = @fopen($database, 'r+b');
            if (!$file) throw new ApiError('storage_unavailable', 503);
            try { self::sync($file); } finally { fclose($file); }
            chmod($database, 0600);
            $append(self::record($stage, 'data/stepdoc.sqlite'));
            $append($this->copy($this->db->config->dataDir . '/auth.key', $stage, 'data/auth.key', 32));
            $configuration = $stage . '/stepdoc.config.json';
            $file = self::newFile($configuration);
            try { self::write($file, self::jsonLine(['origin' => $this->db->config->origin, 'apiPath' => $this->db->config->apiPath])); self::sync($file); }
            finally { fclose($file); }
            $append(self::record($stage, 'stepdoc.config.json'));
            $rows = $copy->query('SELECT key,bytes,sha256 FROM blobs ORDER BY key');
            // A future committed-blob purge must coordinate with the backup lock.
            while ($row = $rows->fetch(\PDO::FETCH_ASSOC)) {
                if (!preg_match('~^[a-f0-9]{48}\.(?:png|webp)$~D', $row['key']) || !preg_match('~^[a-f0-9]{64}$~D', $row['sha256'])) throw new ApiError('corrupt_data', 500);
                $append($this->copy($this->db->config->dataDir . '/blobs/' . $row['key'], $stage, 'data/blobs/' . $row['key'], (int) $row['bytes'], $row['sha256']));
            }
            self::write($manifest, self::jsonLine(['complete' => true, 'files' => $count, 'bytes' => $total, 'sha256' => hash_final($hash)]));
            self::sync($manifest);
        } finally { fclose($manifest); }
        return ['id' => $id, 'createdAt' => $header['createdAt'], 'kind' => $header['kind'], 'files' => $count, 'bytes' => $total];
    }
    private function copy(string $source, string $stage, string $relative, int $expected, ?string $hash = null): array
    {
        clearstatcache(true);
        $real = realpath($source);
        if (!$real || is_link($source) || !self::samePath($real, $source)) throw new ApiError('corrupt_data', 500);
        $input = @fopen($source, 'rb');
        if (!$input) throw new ApiError('storage_unavailable', 503);
        $output = null; $digest = hash_init('sha256'); $size = 0;
        try {
            if (!flock($input, LOCK_SH)) throw new ApiError('storage_unavailable', 503);
            $output = self::newFile($stage . '/' . $relative);
            while (!feof($input)) {
                $bytes = @fread($input, 1048576);
                if ($bytes === false || ($bytes === '' && !feof($input))) throw new ApiError('storage_unavailable', 503);
                $size += strlen($bytes);
                if ($size > $expected) throw new ApiError('corrupt_data', 500);
                hash_update($digest, $bytes); self::write($output, $bytes);
            }
            $actual = hash_final($digest);
            if ($size !== $expected || ($hash !== null && !hash_equals($hash, $actual))) throw new ApiError('corrupt_data', 500);
            self::sync($output);
            return ['path' => $relative, 'bytes' => $size, 'sha256' => $actual];
        } finally { if ($output) fclose($output); flock($input, LOCK_UN); fclose($input); }
    }
    private function summary(string $root, string $id): array
    {
        if (!self::id($id) || is_link($root . '/' . $id)) throw new ApiError('invalid_options');
        $path = $root . '/' . $id . '/manifest.jsonl';
        if (!is_file($path) || is_link($path)) throw new ApiError('corrupt_data', 500);
        $file = @fopen($path, 'rb');
        if (!$file) throw new ApiError('corrupt_data', 500);
        try {
            $header = json_decode((string) fgets($file, 4096), true, 8, JSON_THROW_ON_ERROR);
            if (fseek($file, max(0, (int) fstat($file)['size'] - 1024)) !== 0) throw new ApiError('corrupt_data', 500);
            $tail = stream_get_contents($file, 1025);
            $lines = explode("\n", rtrim($tail, "\n"));
            $footer = json_decode(end($lines), true, 8, JSON_THROW_ON_ERROR);
            if (($header['format'] ?? null) !== self::FORMAT || ($header['id'] ?? null) !== $id || !in_array($header['kind'] ?? null, ['daily', 'manual'], true) || !is_string($header['createdAt'] ?? null) || ($footer['complete'] ?? null) !== true || !is_int($footer['files'] ?? null) || $footer['files'] < 3 || !is_int($footer['bytes'] ?? null) || $footer['bytes'] < 32 || !preg_match('~^[a-f0-9]{64}$~D', $footer['sha256'] ?? '')) throw new ApiError('corrupt_data', 500);
            return ['id' => $id, 'createdAt' => $header['createdAt'], 'kind' => $header['kind'], 'files' => $footer['files'], 'bytes' => $footer['bytes']];
        } finally { fclose($file); }
    }
    public function list(): array
    {
        $root = $this->root();
        if (!is_dir($root)) return [];
        $summaries = [];
        foreach (new \DirectoryIterator($root) as $entry) if (self::id($entry->getFilename()) && $entry->isDir() && !$entry->isLink()) {
            try { $summaries[] = $this->summary($root, $entry->getFilename()); } catch (\Throwable) {}
        }
        usort($summaries, static fn(array $a, array $b): int => strcmp($b['id'], $a['id']));
        return $summaries;
    }
    private function prune(string $root, string $keep): void
    {
        $remaining = self::KEEP - 1;
        foreach ($this->list() as $summary) if ($summary['id'] !== $keep) {
            if ($remaining-- > 0) continue;
            $this->remove($root, $root . '/' . $summary['id']);
        }
    }
    private function remove(string $root, string $path): void
    {
        clearstatcache(true);
        $real = realpath($path);
        if (!$real || is_link($path) || !Config::inside($real, $root) || self::samePath($real, $root) || !self::samePath($real, $path)) throw new ApiError('storage_unavailable', 503);
        foreach (new \DirectoryIterator($real) as $entry) if (!$entry->isDot()) {
            if ($entry->isLink()) { if (!@unlink($entry->getPathname())) throw new ApiError('storage_unavailable', 503); }
            elseif ($entry->isDir()) $this->remove($root, $entry->getPathname());
            elseif (!$entry->isFile() || !@unlink($entry->getPathname())) throw new ApiError('storage_unavailable', 503);
        }
        if (!@rmdir($real)) throw new ApiError('storage_unavailable', 503);
    }
    public function verify(string $id): array
    {
        $root = $this->root();
        if (!self::id($id) || !is_dir($root)) throw new ApiError('invalid_options');
        $lock = $this->lock($root, false);
        if (!$lock) throw new ApiError('storage_unavailable', 503);
        try { return $this->verifyFiles($root, $id); }
        finally { flock($lock, LOCK_UN); fclose($lock); }
    }
    private function verifyFiles(string $root, string $id): array
    {
        $summary = $this->summary($root, $id); $directory = $root . '/' . $id;
        $manifest = $directory . '/manifest.jsonl';
        if (is_link($manifest)) throw new ApiError('corrupt_data', 500);
        $file = @fopen($manifest, 'rb');
        $seen = new \PDO('sqlite::memory:', null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);
        $seen->exec('CREATE TABLE files(path TEXT PRIMARY KEY,bytes INTEGER,sha256 TEXT)');
        $insert = $seen->prepare('INSERT INTO files VALUES(?,?,?)');
        $hash = hash_init('sha256'); $count = 0; $total = 0; $complete = false;
        try {
            $line = fgets($file, 4096); hash_update($hash, $line);
            while (($line = fgets($file, 4096)) !== false) {
                if (!str_ends_with($line, "\n")) throw new ApiError('corrupt_data', 500);
                $entry = json_decode($line, true, 8, JSON_THROW_ON_ERROR);
                if (($entry['complete'] ?? false) === true) {
                    if (count($entry) !== 4 || $entry['files'] !== $count || $entry['bytes'] !== $total || !hash_equals(hash_final($hash), $entry['sha256']) || fgetc($file) !== false) throw new ApiError('corrupt_data', 500);
                    $complete = true; break;
                }
                $path = $entry['path'] ?? null; $bytes = $entry['bytes'] ?? null; $sha = $entry['sha256'] ?? null;
                if (count($entry) !== 3 || !is_string($path) || !preg_match('~^(?:stepdoc\.config\.json|data/(?:stepdoc\.sqlite|auth\.key|blobs/[a-f0-9]{48}\.(?:png|webp)))$~D', $path) || !is_int($bytes) || $bytes < 0 || !is_string($sha) || !preg_match('~^[a-f0-9]{64}$~D', $sha)) throw new ApiError('corrupt_data', 500);
                $full = $directory . '/' . $path; $real = realpath($full);
                if (!$real || is_link($full) || !self::samePath($real, $full) || !is_file($full) || @filesize($full) !== $bytes || !hash_equals($sha, (string) @hash_file('sha256', $full))) throw new ApiError('corrupt_data', 500);
                $insert->execute([$path, $bytes, $sha]); hash_update($hash, $line);
                if (PHP_INT_MAX - $bytes < $total) throw new ApiError('corrupt_data', 500);
                $count++; $total += $bytes;
            }
        } finally { fclose($file); }
        if (!$complete) throw new ApiError('corrupt_data', 500);
        $actual = 0;
        $walk = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($directory, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::SELF_FIRST);
        foreach ($walk as $entry) {
            if ($entry->isLink()) throw new ApiError('corrupt_data', 500);
            if ($entry->isFile()) $actual++;
        }
        if ($actual !== $count + 1 || $seen->query("SELECT count(*) FROM files WHERE path IN ('data/stepdoc.sqlite','data/auth.key','stepdoc.config.json')")->fetchColumn() !== 3 || filesize($directory . '/data/auth.key') !== 32) throw new ApiError('corrupt_data', 500);
        $configuration = json_decode(file_get_contents($directory . '/stepdoc.config.json', false, null, 0, 4097), true, 8, JSON_THROW_ON_ERROR);
        if (count($configuration) !== 2 || !is_string($configuration['origin'] ?? null) || !is_string($configuration['apiPath'] ?? null)) throw new ApiError('corrupt_data', 500);
        $snapshot = new \PDO('sqlite:' . $directory . '/data/stepdoc.sqlite', null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);
        if ($snapshot->query('PRAGMA quick_check')->fetchColumn() !== 'ok' || $snapshot->query('PRAGMA foreign_key_check')->fetch() !== false || (int) $snapshot->query('SELECT count(*) FROM capture_blobs')->fetchColumn() !== 0 || (int) $snapshot->query('SELECT count(*) FROM capture_uploads WHERE committed_at IS NULL')->fetchColumn() !== 0) throw new ApiError('corrupt_data', 500);
        $query = $seen->prepare('SELECT bytes,sha256 FROM files WHERE path=?');
        $rows = $snapshot->query('SELECT key,bytes,sha256 FROM blobs'); $blobs = 0;
        while ($row = $rows->fetch(\PDO::FETCH_ASSOC)) {
            $query->execute(['data/blobs/' . $row['key']]); $entry = $query->fetch(\PDO::FETCH_ASSOC);
            if (!$entry || (int) $entry['bytes'] !== (int) $row['bytes'] || !hash_equals($entry['sha256'], $row['sha256'])) throw new ApiError('corrupt_data', 500);
            $blobs++;
        }
        if ((int) $seen->query("SELECT count(*) FROM files WHERE path LIKE 'data/blobs/%'")->fetchColumn() !== $blobs) throw new ApiError('corrupt_data', 500);
        return [...$summary, 'verified' => true];
    }
}
