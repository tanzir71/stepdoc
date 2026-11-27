<?php
declare(strict_types=1);
namespace StepDoc;

final class Blobs
{
    public function __construct(private readonly Database $db, private readonly Guides $guides) {}
    public function put(array $token, string $guideId, array $fields, array $files): array
    {
        if (array_diff(array_keys($fields), ['kind', 'stepId']) || array_keys($files) !== ['file'] || !is_string($fields['kind'] ?? null) || !in_array($fields['kind'], ['original', 'rendered', 'thumb'], true) || !is_string($fields['stepId'] ?? null) || $fields['stepId'] === '') throw new ApiError('invalid_blob');
        $file = $files['file'];
        if (!is_array($file) || !is_int($file['error'] ?? null)) throw new ApiError('invalid_blob');
        if (in_array($file['error'], [UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE], true)) throw new ApiError('upload_too_large', 413);
        if ($file['error'] !== UPLOAD_ERR_OK || !is_string($file['tmp_name'] ?? null) || !is_uploaded_file($file['tmp_name'])) throw new ApiError('invalid_blob');
        $size = filesize($file['tmp_name']);
        if ($size > $this->db->config->maxUploadBytes) throw new ApiError('upload_too_large', 413);
        if ($size === false || $size < 12) throw new ApiError('invalid_blob');
        $head = file_get_contents($file['tmp_name'], false, null, 0, 12);
        $mime = $file['type'] ?? '';
        // Transport signature only: do not decode, inspect or transform pixels.
        $png = $mime === 'image/png' && str_starts_with($head, "\x89PNG\r\n\x1a\n");
        $webp = $mime === 'image/webp' && substr($head, 0, 4) === 'RIFF' && substr($head, 8, 4) === 'WEBP';
        if (!$png && !$webp) throw new ApiError('invalid_blob');
        $key = bin2hex(random_bytes(24)) . ($png ? '.png' : '.webp');
        $directory = $this->db->config->dataDir . '/blobs';
        if (!is_dir($directory) && !mkdir($directory, 0700) && !is_dir($directory)) throw new ApiError('storage_unavailable', 503);
        $path = $directory . '/' . $key;
        try {
            return $this->db->transaction(function () use ($token, $guideId, $fields, $file, $size, $mime, $key, $path): array {
                $guide = $this->guides->get($token['workspace_id'], $guideId);
                if (!array_filter($guide->steps, static fn(object $step): bool => $step->id === $fields['stepId'])) throw new ApiError('invalid_blob');
                if (!move_uploaded_file($file['tmp_name'], $path)) throw new ApiError('storage_unavailable', 503);
                @chmod($path, 0600);
                $this->db->execute('INSERT INTO blobs VALUES(?,?,?,?,?,?,?,?,?)', [$key, $token['workspace_id'], $guideId, $fields['stepId'], $fields['kind'], $mime, $size, hash_file('sha256', $path), Database::now()]);
                $this->db->audit($token['workspace_id'], Tokens::actor($token), 'blob.create', $key);
                return ['key' => $key];
            });
        } catch (\Throwable $error) {
            // The path is a random server-owned filename beneath the validated data root.
            if (is_file($path)) unlink($path);
            throw $error;
        }
    }
    public function get(string $workspace, string $key): array
    {
        if (!preg_match('~^[a-f0-9]{48}\.(?:png|webp)$~D', $key)) throw new ApiError('not_found', 404);
        $row = $this->db->one('SELECT b.* FROM blobs b JOIN guides g ON g.workspace_id=b.workspace_id AND g.id=b.guide_id WHERE b.key=? AND b.workspace_id=? AND g.deleted_at IS NULL', [$key, $workspace]);
        if (!$row) throw new ApiError('not_found', 404);
        $path = $this->db->config->dataDir . '/blobs/' . $key;
        if (!is_file($path) || filesize($path) !== (int) $row['bytes'] || !hash_equals($row['sha256'], hash_file('sha256', $path))) throw new ApiError('corrupt_data', 500);
        $row['path'] = $path;
        return $row;
    }
}
