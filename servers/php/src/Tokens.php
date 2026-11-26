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

    public function issue(string $workspace, string $name, array $scopes, ?string $origin = null): array
    {
        if (!$scopes || array_diff($scopes, self::SCOPES) || count($scopes) !== count(array_unique($scopes)) || !$name || strlen($name) > 120 || ($origin !== null && !self::extensionOrigin($origin))) throw new ApiError('invalid_options');
        if (!$this->db->one('SELECT id FROM workspaces WHERE id=?', [$workspace])) throw new ApiError('not_found', 404);
        $token = 'sd_' . rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
        $id = Database::id();
        $this->db->transaction(function () use ($id, $workspace, $name, $scopes, $origin, $token): void {
            $this->db->execute('INSERT INTO tokens(id,workspace_id,name,kind,token_hash,scopes,extension_id) VALUES(?,?,?,?,?,?,?)', [$id, $workspace, $name, $origin ? 'extension' : 'token', hash('sha256', $token), json_encode($scopes, JSON_THROW_ON_ERROR), $origin]);
            $this->db->audit($workspace, 'cli', 'token.issue', $id);
        });
        return ['id' => $id, 'token' => $token, 'scopes' => $scopes];
    }

    public function authenticate(?string $authorization, ?string $origin): array
    {
        if (!$authorization || !preg_match('~^Bearer (sd_[A-Za-z0-9_-]{43})$~D', $authorization, $match)) throw new ApiError('unauthorized', 401);
        $row = $this->db->one('SELECT * FROM tokens WHERE token_hash=? AND revoked_at IS NULL', [hash('sha256', $match[1])]);
        if (!$row) throw new ApiError('unauthorized', 401);
        if ($row['extension_id'] !== null && $origin !== $row['extension_id']) throw new ApiError('forbidden', 403);
        $row['scopes'] = json_decode($row['scopes'], true, 32, JSON_THROW_ON_ERROR);
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

    public function allowsOrigin(string $origin): bool
    {
        // A registered, revoked device may read its 401 response; the token is still denied.
        return self::extensionOrigin($origin) && $this->db->one('SELECT id FROM tokens WHERE extension_id=? LIMIT 1', [$origin]) !== null;
    }

    public function revoke(string $id): void
    {
        $this->db->transaction(function () use ($id): void {
            $row = $this->db->one('SELECT workspace_id FROM tokens WHERE id=?', [$id]);
            if (!$row) throw new ApiError('not_found', 404);
            $this->db->execute('UPDATE tokens SET revoked_at=? WHERE id=?', [Database::now(), $id]);
            $this->db->audit($row['workspace_id'], 'cli', 'token.revoke', $id);
        });
    }
}
