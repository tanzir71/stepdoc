<?php
declare(strict_types=1);
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
try {
    $input = json_decode(stream_get_contents(STDIN), true, 8, JSON_THROW_ON_ERROR);
    if (!class_exists(ZipArchive::class)) throw new RuntimeException();
    $zip = new ZipArchive();
    if ($zip->open($input['archive'], ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) throw new RuntimeException();
    $root = realpath($input['directory']);
    if (!$root) throw new RuntimeException();
    $files = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS));
    foreach ($files as $file) {
        if (!$file->isFile() || $file->isLink()) throw new RuntimeException();
        $relative = str_replace('\\', '/', substr($file->getPathname(), strlen($root) + 1));
        if (!$zip->addFile($file->getPathname(), 'stepdoc/' . $relative)) throw new RuntimeException();
    }
    if (!$zip->close()) throw new RuntimeException();
} catch (Throwable $error) { fwrite(STDERR, "Archive operation failed.\n"); exit(1); }
