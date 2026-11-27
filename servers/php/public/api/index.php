<?php
declare(strict_types=1);
$_SERVER['SCRIPT_NAME'] = rtrim(str_replace('\\', '/', dirname(dirname($_SERVER['SCRIPT_NAME'] ?? '/api/index.php'))), '/') . '/index.php';
require __DIR__ . '/../index.php';
