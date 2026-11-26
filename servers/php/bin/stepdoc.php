<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
try {
    /** @var \StepDoc\Database $db */
    $db = require __DIR__ . '/../bootstrap.php';
    $input = json_decode(stream_get_contents(STDIN), true, 32, JSON_THROW_ON_ERROR);
    if (!is_array($input)) throw new \StepDoc\ApiError('invalid_options');
    $tokens = new \StepDoc\Tokens($db);
    switch ($argv[1] ?? '') {
        case 'workspace:create':
            if (!is_string($input['name'] ?? null) || !trim($input['name']) || strlen($input['name']) > 200) throw new \StepDoc\ApiError('invalid_options');
            $id = \StepDoc\Database::id();
            $db->transaction(function () use ($db, $id, $input): void {
                $db->execute('INSERT INTO workspaces VALUES(?,?,?,?)', [$id, $input['name'], '{}', \StepDoc\Database::now()]);
                $db->audit($id, 'cli', 'workspace.create', $id);
            });
            $output = ['id' => $id];
            break;
        case 'token:issue':
            $output = $tokens->issue($input['workspaceId'], $input['name'], $input['scopes'], $input['origin'] ?? null);
            break;
        case 'token:revoke':
            $tokens->revoke($input['id']);
            $output = ['revoked' => true];
            break;
        default: throw new \StepDoc\ApiError('invalid_options');
    }
    fwrite(STDOUT, json_encode($output, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES) . "\n");
} catch (Throwable $error) {
    fwrite(STDERR, json_encode(['error' => ['code' => $error instanceof \StepDoc\ApiError ? $error->errorCode : 'storage_unavailable', 'message' => 'Command failed.']]) . "\n");
    exit(1);
}
