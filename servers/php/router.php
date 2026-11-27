<?php
declare(strict_types=1);

// The local development server has the same public root as Apache's deployment.
$api = getenv('STEPDOC_API_PATH') ?: '/api/v1';
$_SERVER['SCRIPT_NAME'] = substr($api, 0, -strlen('/api/v1')) . '/index.php';
require __DIR__ . '/public/index.php';
