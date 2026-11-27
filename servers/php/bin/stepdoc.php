<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
try {
    /** @var \StepDoc\Database $db */
    $db = require __DIR__ . '/../bootstrap.php';
    $input = json_decode(stream_get_contents(STDIN), true, 32, JSON_THROW_ON_ERROR);
    if (!is_array($input)) throw new \StepDoc\ApiError('invalid_options');
    $tokens = new \StepDoc\Tokens($db);
    $sessions = new \StepDoc\Sessions($db, new \StepDoc\AuthState($db), $tokens);
    switch ($argv[1] ?? '') {
        case 'backup:create':
        case 'backup:list':
            if ($input !== []) throw new \StepDoc\ApiError('invalid_options');
            $backups = new \StepDoc\Backups($db);
            $output = $argv[1] === 'backup:create' ? $backups->create() : ['backups' => $backups->list()];
            break;
        case 'backup:verify':
            if (array_keys($input) !== ['id'] || !is_string($input['id'])) throw new \StepDoc\ApiError('invalid_options');
            $output = (new \StepDoc\Backups($db))->verify($input['id']);
            break;
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
        case 'owner:create':
            $output = $sessions->addMember($input['workspaceId'], $input['name'], $input['email'], 'owner', true);
            break;
        case 'member:add':
            if (!is_string($input['role'] ?? null) || !in_array($input['role'], ['editor', 'viewer'], true)) throw new \StepDoc\ApiError('invalid_options');
            $output = $sessions->addMember($input['workspaceId'], $input['name'], $input['email'], $input['role']);
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
