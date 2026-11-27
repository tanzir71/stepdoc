<?php
declare(strict_types=1);
namespace StepDoc;

/** Private state shared by authentication and device enrollment. */
final class AuthState
{
    private readonly string $key;
    public function __construct(private readonly Database $db)
    {
        $path = $db->config->dataDir . '/auth.key';
        $mask = umask(0077);
        try { $file = fopen($path, 'c+b'); }
        finally { umask($mask); }
        if (!$file || !flock($file, LOCK_EX)) throw new ApiError('storage_unavailable', 503);
        try {
            @chmod($path, 0600);
            $key = stream_get_contents($file, 33);
            if ($key === '') {
                $key = random_bytes(32);
                if (fwrite($file, $key) !== 32 || !fflush($file)) throw new ApiError('storage_unavailable', 503);
            }
            if (!is_string($key) || strlen($key) !== 32) throw new ApiError('storage_unavailable', 503);
            $this->key = $key;
        } finally { flock($file, LOCK_UN); fclose($file); }
    }
    public function hash(string $kind, string $value): string { return hash_hmac('sha256', $kind . "\0" . $value, $this->key); }
    public static function random(): string { return self::encode(random_bytes(32)); }
    public static function encode(string $bytes): string { return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '='); }
    public static function decode(mixed $value, int $maximum = 65536): string
    {
        if (!is_string($value) || strlen($value) > $maximum * 2 || !preg_match('~^[A-Za-z0-9_-]+$~D', $value)) throw new ApiError('invalid_credential');
        $bytes = base64_decode(strtr($value, '-_', '+/'), true);
        if ($bytes === false || strlen($bytes) > $maximum || self::encode($bytes) !== $value) throw new ApiError('invalid_credential');
        return $bytes;
    }
    public static function object(mixed $body, array $keys, array $required): object
    {
        if (!$body instanceof \stdClass || array_diff(array_keys(get_object_vars($body)), $keys)) throw new ApiError('invalid_options');
        foreach ($required as $key) if (!property_exists($body, $key)) throw new ApiError('invalid_options');
        return $body;
    }
    public static function email(mixed $email): string
    {
        if (!is_string($email) || strlen($email) > 254 || !filter_var($email, FILTER_VALIDATE_EMAIL)) throw new ApiError('invalid_options');
        return strtolower($email);
    }
    public function requireOrigin(): void
    {
        if (($_SERVER['HTTP_ORIGIN'] ?? null) !== $this->db->config->origin) throw new ApiError('forbidden', 403);
    }
    public static function cookie(string $name): ?string
    {
        $value = $_COOKIE[$name] ?? null;
        return is_string($value) && preg_match('~^[A-Za-z0-9_-]{43}$~D', $value) ? $value : null;
    }
    public function setCookie(string $name, string $value, int $expires): void
    {
        $path = substr($this->db->config->apiPath, 0, -strlen('api/v1'));
        setcookie($name, $value, ['expires' => $expires, 'path' => $path, 'secure' => true, 'httponly' => true, 'samesite' => 'Lax']);
    }
    public function rate(array $buckets): void
    {
        $allowed = $this->db->transaction(function () use ($buckets): bool {
            $now = time(); $allowed = true;
            $this->db->execute('DELETE FROM auth_rates WHERE window_started<?', [$now - 86400]);
            foreach ($buckets as [$name, $limit, $seconds]) {
                $key = $this->hash('rate', $name);
                $row = $this->db->one('SELECT * FROM auth_rates WHERE key_hash=?', [$key]);
                $start = $row && (int) $row['window_started'] > $now - $seconds ? (int) $row['window_started'] : $now;
                $attempts = $start === ($row ? (int) $row['window_started'] : -1) ? (int) $row['attempts'] + 1 : 1;
                $this->db->execute('INSERT INTO auth_rates VALUES(?,?,?) ON CONFLICT(key_hash) DO UPDATE SET window_started=excluded.window_started,attempts=excluded.attempts', [$key, $start, $attempts]);
                $allowed = $allowed && $attempts <= $limit;
            }
            return $allowed;
        });
        if (!$allowed) { header('Retry-After: 60'); throw new ApiError('rate_limited', 429); }
    }
    public static function ip(): string { return $_SERVER['REMOTE_ADDR'] ?? 'unknown'; }
}
