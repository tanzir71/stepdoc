<?php
declare(strict_types=1);

ini_set('display_errors', '0');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
try {
    require __DIR__ . '/../vendor/autoload.php';
    \StepDoc\Application::headers();
    \StepDoc\Installer::intercept();
    $config = new \StepDoc\Config();
    (new \StepDoc\HostedApp($config))->serve();
    (new \StepDoc\Application(new \StepDoc\Database($config)))->run();
} catch (Throwable $error) {
    $known = $error instanceof \StepDoc\ApiError;
    http_response_code($known ? $error->status : 503);
    header('Content-Type: application/json; charset=utf-8');
    $payload = ['error' => ['code' => $known ? $error->errorCode : 'storage_unavailable', 'message' => 'Storage operation failed.']];
    if ($known && $error->currentVersion !== null) $payload['error']['currentVersion'] = $error->currentVersion;
    echo json_encode($payload, JSON_UNESCAPED_SLASHES);
}
