<?php
declare(strict_types=1);
if (PHP_VERSION_ID < 80100) {
    http_response_code(503);
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    echo '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>StepDoc host check</title></head><body><header>StepDoc</header><main><h1>PHP 8.1 or later is required</h1><p>Choose PHP 8.1 or later in your hosting control panel, then reload this host check.</p></main><footer>StepDoc installation</footer></body></html>';
    exit;
}
require __DIR__ . '/index.php';
