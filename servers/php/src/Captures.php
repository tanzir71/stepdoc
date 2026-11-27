<?php
declare(strict_types=1);
namespace StepDoc;

/** Private capture staging; guide JSON and bytes become visible in one transaction. */
final class Captures
{
    public function __construct(private readonly Database $db, private readonly Guides $guides, private readonly Blobs $blobs, private readonly GuideValidator $validator) {}
    private function expire(): void
    {
        $keys = $this->db->transaction(function (): array {
            $before = time() - 86400;
            $rows = $this->db->execute('SELECT b.key FROM capture_blobs b JOIN capture_uploads c ON c.workspace_id=b.workspace_id AND c.guide_id=b.guide_id WHERE c.committed_at IS NULL AND c.updated_at<?', [$before])->fetchAll();
            $this->db->execute('DELETE FROM capture_uploads WHERE committed_at IS NULL AND updated_at<?', [$before]);
            return array_column($rows, 'key');
        });
        $this->blobs->discard($keys);
    }
    private function intent(array $token, string $id, string $uuid): array
    {
        Guides::id($id);
        if (!preg_match('~^(?:urn:uuid:)?[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$~iD', $uuid)) throw new ApiError('invalid_guide');
        $row = $this->db->one('SELECT * FROM capture_uploads WHERE workspace_id=? AND guide_id=?', [$token['workspace_id'], $id]);
        if ($row && ($row['uuid'] !== $uuid || $row['actor'] !== Tokens::actor($token))) throw new ApiError('conflict', 409);
        if (!$row) {
            if ($this->db->one('SELECT id FROM guides WHERE workspace_id=? AND id=?', [$token['workspace_id'], $id]) || $this->db->one('SELECT guide_id FROM capture_uploads WHERE workspace_id=? AND uuid=?', [$token['workspace_id'], $uuid])) throw new ApiError('conflict', 409);
            $this->db->execute('INSERT INTO capture_uploads VALUES(?,?,?,?,?,NULL)', [$token['workspace_id'], $id, $uuid, Tokens::actor($token), time()]);
            return ['committed_at' => null];
        }
        $this->db->execute('UPDATE capture_uploads SET updated_at=? WHERE workspace_id=? AND guide_id=?', [time(), $token['workspace_id'], $id]);
        return $row;
    }
    public function stage(array $token, string $id, array $fields, array $files): array
    {
        if (array_diff(array_keys($fields), ['captureUuid', 'stepId', 'kind']) || !is_string($fields['captureUuid'] ?? null) || !is_string($fields['stepId'] ?? null) || $fields['stepId'] === '' || !preg_match('//u', $fields['stepId']) || preg_match_all('/./us', $fields['stepId']) > 200 || !in_array($fields['kind'] ?? null, ['original', 'rendered'], true)) throw new ApiError('invalid_blob');
        $info = $this->blobs->uploaded($files);
        $this->expire(); $created = []; $discard = [];
        try {
            $result = $this->db->transaction(function () use ($token, $id, $fields, $info, &$created, &$discard): array {
                $intent = $this->intent($token, $id, $fields['captureUuid']);
                if ($intent['committed_at'] !== null || $this->db->one('SELECT id FROM guides WHERE workspace_id=? AND id=?', [$token['workspace_id'], $id])) throw new ApiError('conflict', 409);
                $old = $this->db->one('SELECT * FROM capture_blobs WHERE workspace_id=? AND guide_id=? AND step_id=? AND kind=?', [$token['workspace_id'], $id, $fields['stepId'], $fields['kind']]);
                if ($old && $old['sha256'] === $info['sha256'] && $old['mime'] === $info['mime'] && (int) $old['bytes'] === $info['bytes'] && $this->blobs->intact($old)) return ['key' => $old['key']];
                if (!$old && (int) $this->db->one('SELECT COUNT(*) AS n FROM capture_blobs WHERE workspace_id=? AND guide_id=?', [$token['workspace_id'], $id])['n'] >= 1000) throw new ApiError('upload_too_large', 413);
                $row = $this->blobs->receive($info, $token['workspace_id'], $id, $fields['stepId'], $fields['kind']);
                $created[] = $row['key'];
                if ($old) {
                    $this->db->execute('DELETE FROM capture_blobs WHERE key=?', [$old['key']]);
                    $discard[] = $old['key'];
                }
                $this->db->execute('INSERT INTO capture_blobs VALUES(?,?,?,?,?,?,?,?,?)', array_values($row));
                $this->db->audit($token['workspace_id'], Tokens::actor($token), 'capture.blob', $row['key']);
                return ['key' => $row['key']];
            });
        } catch (\Throwable $error) {
            $this->blobs->discard($created);
            throw $error;
        }
        $this->blobs->discard($discard);
        return $result;
    }
    public function commit(array $token, mixed $input): array
    {
        $guide = $this->validator->parse($input);
        if (!isset($guide->uuid) || $guide->version !== 1 || $guide->status !== 'draft' || (($guide->publish->isPublic ?? false) || ($guide->publish->publicId ?? null) !== null || ($guide->publish->targets ?? []))) throw new ApiError('invalid_guide');
        foreach ($guide->steps as $step) {
            foreach ($step->redactions as $redaction) if ($redaction->status === 'open') throw new ApiError('redaction_open', 423);
            if (isset($step->screenshot)) {
                $s = $step->screenshot;
                if ($s->width < 1 || $s->width > 16384 || $s->height < 1 || $s->height > 16384 || $s->devicePixelRatio <= 0 || $s->devicePixelRatio > 8) throw new ApiError('invalid_blob');
            }
        }
        $this->expire(); $created = []; $unused = [];
        try {
            $saved = $this->db->transaction(function () use ($token, $guide, &$created, &$unused): object {
                $intent = $this->intent($token, $guide->id, $guide->uuid);
                if ($intent['committed_at'] !== null) return $this->guides->get($token['workspace_id'], $guide->id);
                $pending = []; $used = [];
                foreach ($guide->steps as $step) {
                    if (!isset($step->screenshot)) continue;
                    foreach (['original', 'rendered'] as $kind) {
                        $url = $step->screenshot->$kind ?? null;
                        if ($url === null && $kind === 'original') continue;
                        if (!is_string($url) || $url === '') throw new ApiError('invalid_blob');
                        if (str_starts_with($url, 'data:')) {
                            $row = $this->blobs->inline($url, $token['workspace_id'], $guide->id, $step->id, $kind);
                            $created[] = $row['key'];
                        } else {
                            $row = $this->db->one('SELECT * FROM capture_blobs WHERE key=? AND workspace_id=? AND guide_id=? AND step_id=? AND kind=?', [$url, $token['workspace_id'], $guide->id, $step->id, $kind]);
                            if (!$row) throw new ApiError('invalid_blob');
                            if (!$this->blobs->intact($row)) throw new ApiError('corrupt_data', 500);
                        }
                        $pending[] = $row; $used[] = $row['key'];
                        $step->screenshot->$kind = $row['key'];
                    }
                }
                $saved = $this->guides->create($token, $guide, $pending);
                $all = $this->db->execute('SELECT key FROM capture_blobs WHERE workspace_id=? AND guide_id=?', [$token['workspace_id'], $guide->id])->fetchAll();
                $unused = array_values(array_diff(array_column($all, 'key'), $used));
                $this->db->execute('DELETE FROM capture_blobs WHERE workspace_id=? AND guide_id=?', [$token['workspace_id'], $guide->id]);
                $this->db->execute('UPDATE capture_uploads SET committed_at=?,updated_at=? WHERE workspace_id=? AND guide_id=?', [time(), time(), $token['workspace_id'], $guide->id]);
                $this->db->audit($token['workspace_id'], Tokens::actor($token), 'capture.commit', $guide->id);
                return $saved;
            });
        } catch (\Throwable $error) {
            $this->blobs->discard($created);
            throw $error;
        }
        $this->blobs->discard($unused);
        $root = substr($this->db->config->apiPath, 0, -strlen('api/v1'));
        return ['guide' => $saved, 'editUrl' => $root . 'g/' . $saved->id . '/edit'];
    }
}
