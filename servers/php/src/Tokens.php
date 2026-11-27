<?php
declare(strict_types=1);
namespace StepDoc;

final class Tokens
{
    public const SCOPES = ['capture:write', 'guides:read', 'guides:write', 'publish:write', 'replay:write', 'admin'];
    public function __construct(private readonly Database $db) {}

    public static function extensionOrigin(string $origin): bool
    {
        return (bool) preg_match('~^(?:chrome-extension://[a-p]{32}|moz-extension://[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$~D', $origin);
    }

    public function issue(string $workspace, string $name, array $scopes, ?string $origin = null, ?string $createdBy = null, string $actor = 'cli'): array
    {
        if (!$scopes || array_diff($scopes, self::SCOPES) || count($scopes) !== count(array_unique($scopes)) || !$name || strlen($name) > 120 || ($origin !== null && !self::extensionOrigin($origin))) throw new ApiError('invalid_options');
        if (!$this->db->one('SELECT id FROM workspaces WHERE id=?', [$workspace])) throw new ApiError('not_found', 404);
        $token = 'sd_' . rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
        $id = Database::id();
        $this->db->transaction(function () use ($id, $workspace, $name, $scopes, $origin, $token, $createdBy, $actor): void {
            $this->db->execute('INSERT INTO tokens(id,workspace_id,name,kind,token_hash,scopes,extension_id,created_by) VALUES(?,?,?,?,?,?,?,?)', [$id, $workspace, $name, $origin ? 'extension' : 'token', hash('sha256', $token), json_encode($scopes, JSON_THROW_ON_ERROR), $origin, $createdBy]);
            $this->db->audit($workspace, $actor, 'token.issue', $id);
        });
        return ['id' => $id, 'token' => $token, 'scopes' => $scopes];
    }

    public function authenticate(?string $authorization, ?string $origin): array
    {
        if (!$authorization || !preg_match('~^Bearer (sd_[A-Za-z0-9_-]{43})$~D', $authorization, $match)) throw new ApiError('unauthorized', 401);
        $row = $this->db->one('SELECT * FROM tokens WHERE token_hash=? AND revoked_at IS NULL', [hash('sha256', $match[1])]);
        if (!$row) throw new ApiError('unauthorized', 401);
        if ($row['extension_id'] !== null) {
            // Chrome's privileged extension GET fetch omits Origin. The bearer
            // still authenticates the read; any supplied origin must match, and
            // state-changing extension requests must supply the registered one.
            $originlessRead = $origin === null && ($_SERVER['REQUEST_METHOD'] ?? '') === 'GET';
            if (!$originlessRead && $origin !== $row['extension_id']) throw new ApiError('forbidden', 403);
        }
        $row['scopes'] = json_decode($row['scopes'], true, 32, JSON_THROW_ON_ERROR);
        if ($row['created_by'] !== null) {
            $member = $this->db->one('SELECT role FROM members WHERE id=? AND workspace_id=?', [$row['created_by'], $row['workspace_id']]);
            if (!$member) throw new ApiError('unauthorized', 401);
            $row['scopes'] = self::constrainScopes($row['scopes'], $member['role']);
        }
        // Authenticate on every request; only observational metadata is throttled.
        if ($row['last_seen_at'] === null || strtotime($row['last_seen_at']) <= time() - 60) {
            $this->db->execute('UPDATE tokens SET last_seen_at=? WHERE id=?', [Database::now(), $row['id']]);
        }
        return $row;
    }

    public static function requireScope(array $token, string $scope): void
    {
        if (!in_array('admin', $token['scopes'], true) && !in_array($scope, $token['scopes'], true)) throw new ApiError('forbidden', 403);
    }
    public static function actor(array $principal): string { return ($principal['kind'] === 'session' ? 'member:' : 'token:') . $principal['id']; }
    public static function memberId(array $principal): ?string { return $principal['kind'] === 'session' ? $principal['id'] : ($principal['created_by'] ?? null); }
    public static function constrainScopes(array $scopes, string $role): array
    {
        $allowed = self::roleScopes($role);
        if (in_array('admin', $allowed, true)) return $scopes;
        return array_values(array_intersect(in_array('admin', $scopes, true) ? self::SCOPES : $scopes, $allowed));
    }
    public static function roleScopes(string $role): array
    {
        return $role === 'owner' ? ['admin'] : ($role === 'editor' ? ['guides:read', 'guides:write', 'capture:write', 'publish:write', 'replay:write'] : ['guides:read']);
    }

    public function allowsOrigin(string $origin): bool
    {
        // A registered, revoked device may read its 401 response; the token is still denied.
        return self::extensionOrigin($origin) && $this->db->one('SELECT id FROM tokens WHERE extension_id=? LIMIT 1', [$origin]) !== null;
    }

    public function revoke(string $id, string $actor = 'cli'): void
    {
        $this->db->transaction(function () use ($id, $actor): void {
            $row = $this->db->one('SELECT workspace_id FROM tokens WHERE id=?', [$id]);
            if (!$row) throw new ApiError('not_found', 404);
            $this->db->execute('UPDATE tokens SET revoked_at=? WHERE id=?', [Database::now(), $id]);
            $this->db->audit($row['workspace_id'], $actor, 'token.revoke', $id);
        });
    }
}
