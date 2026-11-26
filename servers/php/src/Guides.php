<?php
declare(strict_types=1);
namespace StepDoc;

final class Guides
{
    public function __construct(private readonly Database $db, private readonly GuideValidator $validator) {}
    public static function id(string $id): void
    {
        if (!preg_match('~^[a-z0-9][a-z0-9-]{2,80}$~D', $id)) throw new ApiError('invalid_guide');
    }
    public function row(string $workspace, string $id): array
    {
        self::id($id);
        $row = $this->db->one('SELECT * FROM guides WHERE workspace_id=? AND id=? AND deleted_at IS NULL', [$workspace, $id]);
        if (!$row) throw new ApiError('not_found', 404);
        return $row;
    }
    public function get(string $workspace, string $id): object
    {
        return json_decode($this->row($workspace, $id)['doc_json'], false, 512, JSON_THROW_ON_ERROR);
    }
    public function validateBlobs(string $workspace, object $guide): void
    {
        foreach ($guide->steps as $step) {
            if (!isset($step->screenshot)) continue;
            foreach ([$step->screenshot->original ?? null, $step->screenshot->rendered] as $key) {
                if ($key === null || $key === '') continue;
                if (!$this->db->one('SELECT key FROM blobs WHERE workspace_id=? AND guide_id=? AND key=?', [$workspace, $guide->id, $key])) throw new ApiError('invalid_blob');
            }
        }
    }
    public function create(array $token, mixed $input): object
    {
        $guide = $this->validator->parse($input);
        self::id($guide->id);
        return $this->db->transaction(function () use ($token, $guide): object {
            if ($this->db->one('SELECT id FROM guides WHERE workspace_id=? AND id=?', [$token['workspace_id'], $guide->id])) throw new ApiError('conflict', 409);
            $this->validateBlobs($token['workspace_id'], $guide);
            $guide->version = 1;
            $guide->updatedAt = Database::now();
            // Public-state changes belong to the policy-gated publish endpoint.
            if (isset($guide->publish) && (($guide->publish->isPublic ?? false) || ($guide->publish->publicId ?? null) !== null || ($guide->publish->targets ?? []))) throw new ApiError('forbidden', 403);
            $json = json_encode($guide, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            $this->db->execute('INSERT INTO guides(workspace_id,id,slug,title,status,collection_id,version,doc_json,updated_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', [$token['workspace_id'], $guide->id, $guide->id, $guide->title, $guide->status, $guide->collectionId ?? null, 1, $json, $guide->updatedAt, $guide->createdAt]);
            $this->version($token, $guide, $json, 'Created');
            return $guide;
        });
    }
    public function save(array $token, string $id, mixed $input, ?string $ifMatch): object
    {
        $guide = $this->validator->parse($input);
        if ($guide->id !== $id || !$ifMatch || !preg_match('~^(?:"([1-9][0-9]{0,15})"|([1-9][0-9]{0,15}))$~D', $ifMatch, $match)) throw new ApiError('invalid_guide');
        $expected = (int) (($match[1] ?? '') !== '' ? $match[1] : $match[2]);
        if ($expected >= 9007199254740991) throw new ApiError('invalid_guide');
        return $this->db->transaction(function () use ($token, $id, $guide, $expected): object {
            $row = $this->row($token['workspace_id'], $id);
            $previous = json_decode($row['doc_json'], false, 512, JSON_THROW_ON_ERROR);
            if ((int) $row['version'] !== $expected || $guide->version !== $expected) throw new ApiError('conflict', 409, (int) $row['version']);
            if (($previous->uuid ?? null) !== ($guide->uuid ?? null) || $previous->createdAt !== $guide->createdAt) throw new ApiError('invalid_guide');
            if (($previous->publish ?? null) != ($guide->publish ?? null)) throw new ApiError('forbidden', 403);
            $this->validateBlobs($token['workspace_id'], $guide);
            $guide->version++;
            $guide->updatedAt = Database::now();
            $json = json_encode($guide, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            $this->db->execute('UPDATE guides SET title=?,status=?,collection_id=?,version=?,doc_json=?,updated_at=? WHERE workspace_id=? AND id=?', [$guide->title, $guide->status, $guide->collectionId ?? null, $guide->version, $json, $guide->updatedAt, $token['workspace_id'], $id]);
            $this->version($token, $guide, $json, 'Updated');
            return $guide;
        });
    }
    private function version(array $token, object $guide, string $json, string $summary): void
    {
        $this->db->execute('INSERT INTO guide_versions VALUES(?,?,?,?,?,?,?)', [$token['workspace_id'], $guide->id, $guide->version, $json, 'token:' . $token['id'], $summary, $guide->updatedAt]);
        $this->db->audit($token['workspace_id'], 'token:' . $token['id'], 'guide.' . ($guide->version === 1 ? 'create' : 'save'), $guide->id);
    }
    public function versions(string $workspace, string $id): array
    {
        $this->row($workspace, $id);
        return array_map(static fn(array $row): array => ['version' => (int) $row['version'], 'at' => $row['created_at'], 'by' => $row['member_id'], 'summary' => $row['summary']], $this->db->execute('SELECT version,created_at,member_id,summary FROM guide_versions WHERE workspace_id=? AND guide_id=? ORDER BY version DESC', [$workspace, $id])->fetchAll());
    }
    public function historical(string $workspace, string $id, string $version): object
    {
        $this->row($workspace, $id);
        if (!preg_match('~^[1-9][0-9]{0,15}$~D', $version) || (int) $version > 9007199254740991) throw new ApiError('invalid_guide');
        $row = $this->db->one('SELECT doc_json FROM guide_versions WHERE workspace_id=? AND guide_id=? AND version=?', [$workspace, $id, (int) $version]);
        if (!$row) throw new ApiError('not_found', 404);
        return json_decode($row['doc_json'], false, 512, JSON_THROW_ON_ERROR);
    }
    public function delete(array $token, string $id): void
    {
        $this->db->transaction(function () use ($token, $id): void {
            $this->row($token['workspace_id'], $id);
            $this->db->execute('UPDATE guides SET deleted_at=? WHERE workspace_id=? AND id=?', [Database::now(), $token['workspace_id'], $id]);
            $this->db->audit($token['workspace_id'], 'token:' . $token['id'], 'guide.trash', $id);
        });
    }
    public function list(string $workspace, array $query): array
    {
        if (array_diff(array_keys($query), ['q', 'status', 'collection', 'cursor'])) throw new ApiError('invalid_query');
        foreach ($query as $key => $value) {
            if (!is_string($value) || !preg_match('//u', $value) || strlen($value) > ($key === 'cursor' ? 2048 : 4000)) throw new ApiError('invalid_query');
        }
        $q = trim($query['q'] ?? '');
        if (strlen(iconv('UTF-8', 'UTF-16LE', $q)) / 2 > 1000) throw new ApiError('invalid_query');
        $status = $query['status'] ?? null;
        if ($status !== null && !in_array($status, ['draft', 'published', 'archived', 'needs-review', 'replay-passed'], true)) throw new ApiError('invalid_query');
        $filter = hash('sha256', json_encode([$q, $status, $query['collection'] ?? null], JSON_THROW_ON_ERROR));
        $cursor = null;
        if (isset($query['cursor'])) {
            try { $cursor = json_decode(base64_decode($query['cursor'], true) ?: '', true, 32, JSON_THROW_ON_ERROR); } catch (\Throwable) { throw new ApiError('invalid_query'); }
            if (!is_array($cursor) || count($cursor) !== 3 || !is_string($cursor['id'] ?? null) || !is_string($cursor['at'] ?? null) || ($cursor['filter'] ?? null) !== $filter || strtotime($cursor['at']) === false) throw new ApiError('invalid_query');
            if (!preg_match('~^[a-z0-9][a-z0-9-]{2,80}$~D', $cursor['id'])) throw new ApiError('invalid_query');
        }
        $sql = 'SELECT doc_json FROM guides WHERE workspace_id=? AND deleted_at IS NULL';
        $params = [$workspace];
        if (isset($query['collection'])) { $sql .= ' AND COALESCE(collection_id,\'\')=?'; $params[] = $query['collection']; }
        if (in_array($status, ['draft', 'published', 'archived'], true)) { $sql .= ' AND status=?'; $params[] = $status; }
        $sql .= ' ORDER BY updated_at DESC,id ASC';
        $statement = $this->db->execute($sql, $params);
        $matches = [];
        while ($row = $statement->fetch()) {
            $guide = json_decode($row['doc_json'], false, 512, JSON_THROW_ON_ERROR);
            if ($cursor && (strcmp($guide->updatedAt, $cursor['at']) > 0 || ($guide->updatedAt === $cursor['at'] && strcmp($guide->id, $cursor['id']) <= 0))) continue;
            if ($status === 'replay-passed' && ($guide->verification->status ?? '') !== 'passed') continue;
            $open = 0; $unclear = false;
            $texts = [$guide->title, $guide->description, $guide->app->name ?? '', $guide->app->origin ?? '', ...$guide->tags];
            $thumb = null;
            foreach ($guide->steps as $step) {
                $open += count(array_filter($step->redactions, static fn(object $item): bool => $item->status === 'open'));
                $unclear = $unclear || $step->lowConfidence;
                $texts[] = $step->title; $texts[] = $step->description;
                if ($thumb === null && isset($step->screenshot)) $thumb = $step->screenshot->rendered;
            }
            if ($status === 'needs-review' && !$open && !$unclear) continue;
            if ($q !== '' && !array_filter($texts, static fn(string $text): bool => preg_match('~' . preg_quote($q, '~') . '~iu', $text) === 1)) continue;
            $summary = ['id' => $guide->id, 'title' => $guide->title, 'stepCount' => count($guide->steps), 'status' => $guide->status, 'openRedactions' => $open, 'verification' => $guide->verification->status ?? 'never-run', 'collectionId' => $guide->collectionId ?? null, 'thumb' => $thumb, 'updatedAt' => $guide->updatedAt];
            if (isset($guide->app)) $summary['appOrigin'] = $guide->app->origin;
            $matches[] = $summary;
            if (count($matches) > $this->db->config->pageSize) break;
        }
        $next = count($matches) > $this->db->config->pageSize;
        $items = array_slice($matches, 0, $this->db->config->pageSize);
        $last = $items ? $items[count($items) - 1] : null;
        return ['items' => $items, 'nextCursor' => $next ? base64_encode(json_encode(['id' => $last['id'], 'at' => $last['updatedAt'], 'filter' => $filter], JSON_THROW_ON_ERROR)) : null];
    }
}
