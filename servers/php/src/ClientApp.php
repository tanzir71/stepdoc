<?php
declare(strict_types=1);
namespace StepDoc;

/** Static client serving shared by installed, initial-setup and explicit browser mode. */
final class ClientApp
{
    public static function serve(string $directory, string $base, array $metadata): never
    {
        $path = parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH);
        if (!is_string($path) || preg_match('~%(?:2f|5c|00)~i', $path)) throw new ApiError('not_found', 404);
        $path = rawurldecode($path);
        if (str_contains($path, '\\') || str_contains($path, "\0") || preg_match('~(?:^|/)\.{1,2}(?:/|$)~', $path)) throw new ApiError('not_found', 404);
        if (!in_array($_SERVER['REQUEST_METHOD'], ['GET', 'HEAD'], true)) {
            header('Allow: GET, HEAD');
            throw new ApiError('method_not_allowed', 405);
        }
        if ($base !== '' && $path === $base) { header('Location: ' . $base . '/', true, 308); exit; }
        if (!str_starts_with($path, $base . '/')) throw new ApiError('not_found', 404);
        $relative = substr($path, strlen($base));
        $root = realpath($directory);
        if (!$root || !is_file($root . '/index.html')) throw new ApiError('storage_unavailable', 503);
        if ($relative === '/theme-init.js' || str_starts_with($relative, '/assets/')) {
            $file = realpath($root . $relative);
            $types = ['js' => 'text/javascript', 'css' => 'text/css', 'svg' => 'image/svg+xml', 'woff2' => 'font/woff2', 'png' => 'image/png', 'webp' => 'image/webp'];
            $type = $types[pathinfo($relative, PATHINFO_EXTENSION)] ?? null;
            if (!$file || !$type || !is_file($file) || !Config::inside($file, $root)) throw new ApiError('not_found', 404);
            header('Content-Type: ' . $type);
            header('Content-Length: ' . filesize($file));
            if (str_starts_with($relative, '/assets/')) header('Cache-Control: public, max-age=31536000, immutable');
            if ($_SERVER['REQUEST_METHOD'] !== 'HEAD') readfile($file);
            exit;
        }
        if ($relative !== '/' && !preg_match('~^/(?:signin|setup|trash|settings/[a-z-]+|c/[a-z0-9][a-z0-9-]{2,80}|g/[a-z0-9][a-z0-9-]{2,80}(?:/(?:edit|export|review))?|p/[a-z0-9-]+)/*$~D', $relative)) throw new ApiError('not_found', 404);
        $html = file_get_contents($root . '/index.html');
        if ($html === false) throw new ApiError('storage_unavailable', 503);
        $html = preg_replace_callback('~((?:src|href)=")\.?/(assets/[^" ]+|theme-init\.js)(")~', static fn(array $match): string => $match[1] . $base . '/' . $match[2] . $match[3], $html);
        $meta = '';
        foreach ($metadata as $name => $value) $meta .= '<meta name="' . htmlspecialchars($name, ENT_QUOTES, 'UTF-8') . '" content="' . htmlspecialchars($value, ENT_QUOTES, 'UTF-8') . '">';
        $html = str_replace('</head>', $meta . '</head>', $html);
        header('Content-Type: text/html; charset=utf-8');
        header('Content-Length: ' . strlen($html));
        if ($_SERVER['REQUEST_METHOD'] !== 'HEAD') echo $html;
        exit;
    }
}
