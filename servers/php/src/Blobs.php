<?php
declare(strict_types=1);
namespace StepDoc;

final class Blobs
{
    public function __construct(private readonly Database $db, private readonly Guides $guides) {}
    public function put(array $token, string $guideId, array $fields, array $files): array
    {
        if (array_diff(array_keys($fields), ['kind', 'stepId']) || !is_string($fields['kind'] ?? null) || !in_array($fields['kind'], ['original', 'rendered', 'thumb'], true) || !is_string($fields['stepId'] ?? null) || $fields['stepId'] === '') throw new ApiError('invalid_blob');
        $info = $this->uploaded($files); $key = null;
        try {
            return $this->db->transaction(function () use ($token, $guideId, $fields, $info, &$key): array {
                $guide = $this->guides->get($token['workspace_id'], $guideId);
                if (!array_filter($guide->steps, static fn(object $step): bool => $step->id === $fields['stepId'])) throw new ApiError('invalid_blob');
                $row = $this->receive($info, $token['workspace_id'], $guideId, $fields['stepId'], $fields['kind']);
                $key = $row['key'];
                $this->db->execute('INSERT INTO blobs VALUES(?,?,?,?,?,?,?,?,?)', array_values($row));
                $this->db->audit($token['workspace_id'], Tokens::actor($token), 'blob.create', $key);
                return ['key' => $key];
            });
        } catch (\Throwable $error) {
            if ($key !== null) $this->discard([$key]);
            throw $error;
        }
    }
    public function uploaded(array $files): array
    {
        if (array_keys($files) !== ['file']) throw new ApiError('invalid_blob');
        $file = $files['file'];
        if (!is_array($file) || !is_int($file['error'] ?? null)) throw new ApiError('invalid_blob');
        if (in_array($file['error'], [UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE], true)) throw new ApiError('upload_too_large', 413);
        if ($file['error'] !== UPLOAD_ERR_OK || !is_string($file['tmp_name'] ?? null) || !is_uploaded_file($file['tmp_name'])) throw new ApiError('invalid_blob');
        $size = filesize($file['tmp_name']);
        if ($size > $this->db->config->maxUploadBytes) throw new ApiError('upload_too_large', 413);
        if ($size === false || $size < 12) throw new ApiError('invalid_blob');
        $head = file_get_contents($file['tmp_name'], false, null, 0, 12);
        $mime = $file['type'] ?? '';
        $this->signature($head, $mime);
        $hash = hash_file('sha256', $file['tmp_name']);
        if ($hash === false) throw new ApiError('storage_unavailable', 503);
        return ['tmp_name' => $file['tmp_name'], 'mime' => $mime, 'bytes' => $size, 'sha256' => $hash];
    }
    private function signature(mixed $head, mixed $mime): void
    {
        if (!is_string($head) || strlen($head) < 12 || !is_string($mime)) throw new ApiError('invalid_blob');
        // Transport signature only: do not decode, inspect or transform pixels.
        $png = $mime === 'image/png' && str_starts_with($head, "\x89PNG\r\n\x1a\n");
        $webp = $mime === 'image/webp' && substr($head, 0, 4) === 'RIFF' && substr($head, 8, 4) === 'WEBP';
        if (!$png && !$webp) throw new ApiError('invalid_blob');
    }
    private function newKey(string $mime): string
    {
        $directory = $this->db->config->dataDir . '/blobs';
        if (!is_dir($directory) && !mkdir($directory, 0700) && !is_dir($directory)) throw new ApiError('storage_unavailable', 503);
        return bin2hex(random_bytes(24)) . ($mime === 'image/png' ? '.png' : '.webp');
    }
    private function metadata(array $info, string $workspace, string $guideId, string $stepId, string $kind, string $key): array
    {
        return ['key' => $key, 'workspace_id' => $workspace, 'guide_id' => $guideId, 'step_id' => $stepId, 'kind' => $kind, 'mime' => $info['mime'], 'bytes' => $info['bytes'], 'sha256' => $info['sha256'], 'created_at' => Database::now()];
    }
    public function receive(array $info, string $workspace, string $guideId, string $stepId, string $kind): array
    {
        $key = $this->newKey($info['mime']);
        $path = $this->db->config->dataDir . '/blobs/' . $key;
        if (!move_uploaded_file($info['tmp_name'], $path)) throw new ApiError('storage_unavailable', 503);
        @chmod($path, 0600);
        return $this->metadata($info, $workspace, $guideId, $stepId, $kind, $key);
    }
    public function inline(string $url, string $workspace, string $guideId, string $stepId, string $kind): array
    {
        if (strlen($url) > 8 * 1024 * 1024) throw new ApiError('upload_too_large', 413);
        if (!preg_match('~^data:(image/(?:png|webp));base64,([A-Za-z0-9+/]+={0,2})$~D', $url, $match)) throw new ApiError('invalid_blob');
        $data = base64_decode($match[2], true);
        if ($data === false || base64_encode($data) !== $match[2]) throw new ApiError('invalid_blob');
        if (strlen($data) > $this->db->config->maxUploadBytes) throw new ApiError('upload_too_large', 413);
        $this->signature(substr($data, 0, 12), $match[1]);
        $key = $this->newKey($match[1]);
        $mask = umask(0077);
        try { $file = fopen($this->db->config->dataDir . '/blobs/' . $key, 'xb'); }
        finally { umask($mask); }
        if (!$file) throw new ApiError('storage_unavailable', 503);
        try {
            $at = 0;
            while ($at < strlen($data)) {
                $written = fwrite($file, substr($data, $at));
                if ($written === false || $written === 0) throw new ApiError('storage_unavailable', 503);
                $at += $written;
            }
            if (!fflush($file)) throw new ApiError('storage_unavailable', 503);
        } catch (\Throwable $error) {
            fclose($file); $this->discard([$key]);
            throw $error;
        }
        fclose($file);
        return $this->metadata(['mime' => $match[1], 'bytes' => strlen($data), 'sha256' => hash('sha256', $data)], $workspace, $guideId, $stepId, $kind, $key);
    }
    public function discard(array $keys): void
    {
        foreach ($keys as $key) {
            if (!is_string($key) || !preg_match('~^[a-f0-9]{48}\.(?:png|webp)$~D', $key)) throw new \LogicException('Invalid private blob key');
            $path = $this->db->config->dataDir . '/blobs/' . $key;
            if (is_file($path)) @unlink($path);
        }
    }
    public function intact(array $row): bool
    {
        $path = $this->db->config->dataDir . '/blobs/' . $row['key'];
        return is_file($path) && filesize($path) === (int) $row['bytes'] && hash_equals($row['sha256'], (string) @hash_file('sha256', $path));
    }
    public function get(string $workspace, string $key): array
    {
        if (!preg_match('~^[a-f0-9]{48}\.(?:png|webp)$~D', $key)) throw new ApiError('not_found', 404);
        $row = $this->db->one('SELECT b.* FROM blobs b JOIN guides g ON g.workspace_id=b.workspace_id AND g.id=b.guide_id WHERE b.key=? AND b.workspace_id=? AND g.deleted_at IS NULL', [$key, $workspace]);
        if (!$row) throw new ApiError('not_found', 404);
        $path = $this->db->config->dataDir . '/blobs/' . $key;
        if (!$this->intact($row)) throw new ApiError('corrupt_data', 500);
        $row['path'] = $path;
        return $row;
    }
}
