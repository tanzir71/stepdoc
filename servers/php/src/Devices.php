<?php
declare(strict_types=1);
namespace StepDoc;

final class Devices
{
    public function __construct(private readonly Database $db, private readonly AuthState $state, private readonly Tokens $tokens) {}
    private function manage(array $principal): void
    {
        if ($principal['kind'] === 'session' && in_array($principal['member']['role'], ['owner', 'editor'], true)) return;
        Tokens::requireScope($principal, 'admin');
    }
    public function code(array $principal): array
    {
        $this->manage($principal);
        $this->state->rate([['pair-create:' . Tokens::actor($principal), 10, 60]]);
        return $this->db->transaction(function () use ($principal): array {
            $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
            do {
                $code = '';
                for ($i = 0; $i < 6; $i++) $code .= $alphabet[random_int(0, strlen($alphabet) - 1)];
                $code = substr($code, 0, 3) . '-' . substr($code, 3);
                $hash = $this->state->hash('pair', $code);
            } while ($this->db->one('SELECT code_hash FROM pairing_codes WHERE code_hash=?', [$hash]));
            $expires = time() + 300;
            $this->db->execute('DELETE FROM pairing_codes WHERE expires_at<?', [time() - 86400]);
            $this->db->execute('INSERT INTO pairing_codes VALUES(?,?,?,?,?,NULL)', [$hash, $principal['workspace_id'], Tokens::actor($principal), Tokens::memberId($principal), $expires]);
            $this->db->audit($principal['workspace_id'], Tokens::actor($principal), 'pairing.create', $principal['workspace_id']);
            return ['code' => $code, 'expiresAt' => gmdate('Y-m-d\TH:i:s', $expires) . '.000Z'];
        });
    }
    public function claim(mixed $input): array
    {
        $this->state->rate([['pair-claim:' . AuthState::ip(), 10, 60], ['pair-hour:' . AuthState::ip(), 60, 3600]]);
        $body = AuthState::object($input, ['code', 'deviceName', 'extensionId'], ['code', 'deviceName', 'extensionId']);
        $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
        if (!Tokens::extensionOrigin($origin) || !is_string($body->extensionId) || $body->extensionId !== parse_url($origin, PHP_URL_HOST)) throw new ApiError('forbidden', 403);
        if (!is_string($body->code) || !preg_match('~^[A-Z0-9]{3}-[A-Z0-9]{3}$~D', $body->code) || !is_string($body->deviceName) || !trim($body->deviceName) || strlen($body->deviceName) > 120) throw new ApiError('invalid_code');
        return $this->db->transaction(function () use ($body, $origin): array {
            $hash = $this->state->hash('pair', $body->code);
            $row = $this->db->one('SELECT * FROM pairing_codes WHERE code_hash=? AND used_at IS NULL AND expires_at>?', [$hash, time()]);
            if (!$row) throw new ApiError('invalid_code');
            if ($row['member_id'] !== null) {
                $member = $this->db->one('SELECT role FROM members WHERE id=? AND workspace_id=?', [$row['member_id'], $row['workspace_id']]);
                if (!$member || !in_array($member['role'], ['owner', 'editor'], true)) throw new ApiError('invalid_code');
            }
            if (str_starts_with($row['created_by'], 'token:')) {
                $tokenId = substr($row['created_by'], strlen('token:'));
                $issuer = $this->db->one('SELECT t.scopes,t.created_by,m.role FROM tokens t LEFT JOIN members m ON m.id=t.created_by AND m.workspace_id=t.workspace_id WHERE t.id=? AND t.workspace_id=? AND t.revoked_at IS NULL', [$tokenId, $row['workspace_id']]);
                if (!$issuer || ($issuer['created_by'] !== null && $issuer['role'] === null)) throw new ApiError('invalid_code');
                $scopes = json_decode($issuer['scopes'], true, 32, JSON_THROW_ON_ERROR);
                if ($issuer['created_by'] !== null) $scopes = Tokens::constrainScopes($scopes, $issuer['role']);
                if (!in_array('admin', $scopes, true)) throw new ApiError('invalid_code');
            }
            $this->db->execute('UPDATE pairing_codes SET used_at=? WHERE code_hash=?', [time(), $hash]);
            $issued = $this->tokens->issue($row['workspace_id'], trim($body->deviceName), ['capture:write', 'guides:read'], $origin, $row['member_id'], $row['created_by']);
            $this->db->audit($row['workspace_id'], $row['created_by'], 'pairing.claim', $issued['id']);
            return $issued;
        });
    }
    public function list(array $principal): array
    {
        $this->manage($principal);
        $sql = 'SELECT id,kind,name,scopes,last_seen_at FROM tokens WHERE workspace_id=? AND revoked_at IS NULL';
        $params = [$principal['workspace_id']];
        if ($principal['kind'] === 'session' && $principal['member']['role'] === 'editor') { $sql .= ' AND created_by=?'; $params[] = $principal['id']; }
        return array_map(static fn(array $row): array => ['id' => $row['id'], 'kind' => $row['kind'], 'name' => $row['name'], 'scopes' => json_decode($row['scopes'], true, 32, JSON_THROW_ON_ERROR), 'lastSeenAt' => $row['last_seen_at']], $this->db->execute($sql . ' ORDER BY id', $params)->fetchAll());
    }
    public function issue(array $principal, mixed $input): array
    {
        $this->manage($principal);
        $body = AuthState::object($input, ['name', 'scopes'], ['name', 'scopes']);
        if (!is_string($body->name) || !trim($body->name) || strlen($body->name) > 120 || !is_array($body->scopes) || !$body->scopes || count($body->scopes) > count(Tokens::SCOPES)) throw new ApiError('invalid_options');
        foreach ($body->scopes as $scope) {
            if (!is_string($scope) || !in_array($scope, Tokens::SCOPES, true)) throw new ApiError('invalid_options');
            Tokens::requireScope($principal, $scope);
        }
        $this->state->rate([['token-create:' . Tokens::actor($principal), 10, 60]]);
        return $this->tokens->issue($principal['workspace_id'], trim($body->name), $body->scopes, null, Tokens::memberId($principal), Tokens::actor($principal));
    }
    public function revoke(array $principal, string $id): void
    {
        $this->manage($principal);
        $row = $this->db->one('SELECT id,created_by FROM tokens WHERE id=? AND workspace_id=?', [$id, $principal['workspace_id']]);
        if (!$row || ($principal['kind'] === 'session' && $principal['member']['role'] === 'editor' && $row['created_by'] !== $principal['id'])) throw new ApiError('not_found', 404);
        $this->tokens->revoke($id, Tokens::actor($principal));
    }
}
