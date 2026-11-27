<?php
declare(strict_types=1);
namespace StepDoc;

final class Config
{
    public readonly string $dataDir;
    public readonly string $apiPath;
    public readonly int $maxUploadBytes;
    public readonly int $maxJsonBytes;
    public readonly string $origin;
    public readonly int $pageSize;
    public readonly string $appDir;

    public function __construct()
    {
        $installed = self::installed();
        $public = realpath(__DIR__ . '/../public');
        $documentRoot = PHP_SAPI !== 'cli' && !empty($_SERVER['DOCUMENT_ROOT']) ? realpath($_SERVER['DOCUMENT_ROOT']) : false;
        $directory = getenv('STEPDOC_DATA_DIR') ?: __DIR__ . '/../data';
        $parent = realpath(dirname($directory));
        if ($parent && (($public && self::inside($parent, $public)) || ($documentRoot && self::inside($parent, $documentRoot)))) throw new ApiError('invalid_options', 503);
        if (!is_dir($directory) && !mkdir($directory, 0700, true) && !is_dir($directory)) {
            throw new ApiError('storage_unavailable', 503);
        }
        $resolved = realpath($directory);
        if (!$resolved || !$public || self::inside($resolved, $public) || ($documentRoot && self::inside($resolved, $documentRoot))) {
            throw new ApiError('invalid_options', 503);
        }
        $this->dataDir = $resolved;
        $this->appDir = getenv('STEPDOC_APP_DIR') ?: (is_file(__DIR__ . '/../app/index.html') ? __DIR__ . '/../app' : dirname(__DIR__, 3) . '/apps/app/dist');
        $path = getenv('STEPDOC_API_PATH') ?: ($installed['apiPath'] ?? '/api/v1');
        if (!preg_match('~^/(?:[a-zA-Z0-9_-]+/)*api/v1$~D', $path)) {
            throw new ApiError('invalid_options', 503);
        }
        $this->apiPath = $path;
        $origin = getenv('STEPDOC_ORIGIN') ?: ($installed['origin'] ?? 'https://localhost');
        $parts = parse_url($origin);
        if (!$parts || array_diff(array_keys($parts), ['scheme', 'host', 'port']) || !isset($parts['scheme'], $parts['host']) ||
            !in_array($parts['scheme'], ['http', 'https'], true) ||
            ($parts['scheme'] === 'http' && !in_array($parts['host'], ['localhost', '127.0.0.1', '[::1]'], true))) throw new ApiError('invalid_options', 503);
        $this->origin = $origin;
        $requested = getenv('STEPDOC_MAX_UPLOAD_BYTES');
        if ($requested === false) $requested = (string) (64 * 1024 * 1024);
        if (!ctype_digit($requested) || (int) $requested < 1 || (int) $requested > 64 * 1024 * 1024) throw new ApiError('invalid_options', 503);
        $this->maxUploadBytes = min((int) $requested, self::iniBytes('upload_max_filesize'), max(1, self::iniBytes('post_max_size') - 65536));
        $this->maxJsonBytes = 8 * 1024 * 1024;
        $pageSize = getenv('STEPDOC_PAGE_SIZE');
        if ($pageSize === false) $pageSize = '100';
        if (!ctype_digit($pageSize) || (int) $pageSize < 1 || (int) $pageSize > 100) throw new ApiError('invalid_options', 503);
        $this->pageSize = (int) $pageSize;
    }

    public static function installed(): array
    {
        $path = __DIR__ . '/../stepdoc.config.json';
        if (!is_file($path)) return [];
        if (filesize($path) > 4096) throw new ApiError('invalid_options', 503);
        try { $value = json_decode(file_get_contents($path), true, 8, JSON_THROW_ON_ERROR); }
        catch (\JsonException) { throw new ApiError('invalid_options', 503); }
        if (!is_array($value) || count($value) !== 2 || !is_string($value['origin'] ?? null) || !is_string($value['apiPath'] ?? null)) throw new ApiError('invalid_options', 503);
        return ['origin' => $value['origin'], 'apiPath' => $value['apiPath']];
    }

    public static function inside(string $path, string $directory): bool
    {
        $path = strtolower(str_replace('\\', '/', $path));
        $directory = rtrim(strtolower(str_replace('\\', '/', $directory)), '/');
        return $path === $directory || str_starts_with($path, $directory . '/');
    }

    public static function iniBytes(string $name): int
    {
        $raw = trim((string) ini_get($name));
        if ($raw === '0' || $raw === '-1') return PHP_INT_MAX;
        $power = ['k' => 1, 'm' => 2, 'g' => 3][strtolower(substr($raw, -1))] ?? 0;
        return max(1, (int) ((float) $raw * (1024 ** $power)));
    }
}
