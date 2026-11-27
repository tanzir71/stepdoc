<?php
declare(strict_types=1);
namespace StepDoc;

final class Sessions
{
    public function __construct(private readonly Database $db, private readonly AuthState $state, private readonly Tokens $tokens) {}
    public function authenticate(): array
    {
        // A bad explicit bearer must never fall back to a more privileged cookie.
        if (isset($_SERVER['HTTP_AUTHORIZATION'])) return $this->tokens->authenticate($_SERVER['HTTP_AUTHORIZATION'], $_SERVER['HTTP_ORIGIN'] ?? null);
        return $this->cookiePrincipal();
    }
    public function cookiePrincipal(): array
    {
        $cookie = AuthState::cookie('sd_session');
        $row = $cookie ? $this->db->one('SELECT m.*,s.role AS session_role,s.method AS auth_method FROM sessions s JOIN members m ON m.id=s.member_id WHERE s.id_hash=? AND s.expires_at>?', [hash('sha256', $cookie), time()]) : null;
        // A role change invalidates old sessions, even when the cookie has not expired.
        if (!$row || $row['role'] !== $row['session_role']) throw new ApiError('unauthorized', 401);
        if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') $this->state->requireOrigin();
        $scopes = Tokens::roleScopes($row['role']);
        return ['id' => $row['id'], 'workspace_id' => $row['workspace_id'], 'kind' => 'session', 'scopes' => $scopes, 'member' => $row];
    }
    public function current(): array
    {
        $principal = $this->authenticate();
        if ($principal['kind'] !== 'session') throw new ApiError('unauthorized', 401);
        return $this->view($principal['member'], $principal['member']['auth_method']);
    }
    public function view(array $member, string $method): array
    {
        $workspace = $this->db->one('SELECT id,name FROM workspaces WHERE id=?', [$member['workspace_id']]);
        return ['member' => array_intersect_key($member, array_flip(['id', 'name', 'email', 'role'])), 'workspace' => $workspace, 'needsPasskey' => $method === 'recovery' || !$this->db->one('SELECT id FROM passkeys WHERE member_id=? LIMIT 1', [$member['id']])];
    }
    /** Return private issuance data to the auth handler; only finish() returns its public projection. */
    public function create(array $member, string $method): array
    {
        return $this->db->transaction(function () use ($member, $method): array {
            $raw = AuthState::random(); $expires = time() + 7 * 86400;
            $old = AuthState::cookie('sd_session');
            if ($old) $this->db->execute('DELETE FROM sessions WHERE id_hash=?', [hash('sha256', $old)]);
            $this->db->execute('DELETE FROM sessions WHERE expires_at<=?', [time()]);
            $this->db->execute('INSERT INTO sessions VALUES(?,?,?,?,?,?)', [hash('sha256', $raw), $member['id'], $expires, hash('sha256', $_SERVER['HTTP_USER_AGENT'] ?? ''), $member['role'], $method]);
            $this->db->execute('UPDATE members SET last_seen_at=? WHERE id=?', [Database::now(), $member['id']]);
            $this->db->audit($member['workspace_id'], $member['id'], 'auth.' . $method, $member['id']);
            return ['response' => $this->view($member, $method), 'cookie' => $raw, 'expires' => $expires];
        });
    }
    public function finish(array $issued): array
    {
        $this->state->setCookie('sd_session', $issued['cookie'], $issued['expires']);
        return $issued['response'];
    }
    public function logout(): void
    {
        $this->state->requireOrigin();
        $cookie = AuthState::cookie('sd_session');
        if ($cookie) $this->db->execute('DELETE FROM sessions WHERE id_hash=?', [hash('sha256', $cookie)]);
        $this->state->setCookie('sd_session', '', 1);
        $this->state->setCookie('sd_auth', '', 1);
    }
    public function addMember(string $workspace, mixed $name, mixed $email, string $role, bool $firstOwner = false): array
    {
        $email = AuthState::email($email);
        if (!is_string($name) || !trim($name) || strlen($name) > 120 || !in_array($role, ['owner', 'editor', 'viewer'], true)) throw new ApiError('invalid_options');
        return $this->db->transaction(function () use ($workspace, $name, $email, $role, $firstOwner): array {
            if (!$this->db->one('SELECT id FROM workspaces WHERE id=?', [$workspace])) throw new ApiError('not_found', 404);
            if ($firstOwner && ($role !== 'owner' || $this->db->one('SELECT id FROM members WHERE workspace_id=? LIMIT 1', [$workspace]))) throw new ApiError('conflict', 409);
            if ($this->db->one('SELECT id FROM members WHERE email=? COLLATE NOCASE', [$email])) throw new ApiError('conflict', 409);
            $id = Database::id();
            $this->db->execute('INSERT INTO members(id,workspace_id,email,name,role,created_at) VALUES(?,?,?,?,?,?)', [$id, $workspace, $email, trim($name), $role, Database::now()]);
            $this->db->audit($workspace, 'cli', 'member.create', $id);
            return ['id' => $id];
        });
    }
}
