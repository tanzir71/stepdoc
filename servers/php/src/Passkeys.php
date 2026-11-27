<?php
declare(strict_types=1);
namespace StepDoc;

use lbuchs\WebAuthn\WebAuthn;
use lbuchs\WebAuthn\WebAuthnException;

final class Passkeys
{
    public function __construct(private readonly Database $db, private readonly AuthState $state, private readonly Sessions $sessions) {}
    public function available(): bool
    {
        return filter_var(trim((string) parse_url($this->db->config->origin, PHP_URL_HOST), '[]'), FILTER_VALIDATE_IP) === false;
    }
    private function library(): WebAuthn
    {
        if (!$this->available()) throw new ApiError('passkeys_unavailable', 503);
        return new WebAuthn('StepDoc', parse_url($this->db->config->origin, PHP_URL_HOST), ['none'], true);
    }
    private function registrationMember(string $email, array $principal): array
    {
        $member = $this->db->one('SELECT * FROM members WHERE email=? COLLATE NOCASE AND workspace_id=?', [$email, $principal['workspace_id']]);
        if (!$member) throw new ApiError('forbidden', 403);
        if ($principal['kind'] === 'session') {
            if ($principal['id'] !== $member['id']) throw new ApiError('forbidden', 403);
        } else {
            // Only the initial owner can enroll through a locally issued admin token.
            Tokens::requireScope($principal, 'admin');
            if ($member['role'] !== 'owner' || $this->db->one('SELECT p.id FROM passkeys p JOIN members m ON m.id=p.member_id WHERE m.workspace_id=? LIMIT 1', [$member['workspace_id']])) throw new ApiError('forbidden', 403);
        }
        return $member;
    }
    public function options(mixed $input): object
    {
        $this->state->requireOrigin();
        $body = AuthState::object($input, ['mode', 'email'], ['mode']);
        if (!in_array($body->mode, ['register', 'authenticate'], true)) throw new ApiError('invalid_options');
        $email = isset($body->email) ? AuthState::email($body->email) : null;
        $this->state->rate([['passkey:' . AuthState::ip(), 30, 60]]);
        $library = $this->library(); $member = null; $actor = null;
        if ($body->mode === 'register') {
            if ($email === null) throw new ApiError('invalid_options');
            $principal = $this->sessions->authenticate();
            $member = $this->registrationMember($email, $principal);
            $actor = Tokens::actor($principal);
            $existing = array_map(static fn(array $row): string => AuthState::decode($row['credential_id'], 1024), $this->db->execute('SELECT credential_id FROM passkeys WHERE member_id=?', [$member['id']])->fetchAll());
            $options = $library->getCreateArgs(hex2bin($member['id']), $email, $member['name'], 120, true, true, null, $existing);
        } else {
            // Discoverable credentials keep options identical for known and unknown emails.
            $options = $library->getGetArgs([], 120, true, true, true, true, true, true);
        }
        $id = AuthState::random(); $expires = time() + 300;
        $this->db->transaction(function () use ($id, $expires, $library, $body, $member, $actor, $email): void {
            $old = AuthState::cookie('sd_auth');
            if ($old) $this->db->execute('DELETE FROM auth_challenges WHERE id_hash=?', [hash('sha256', $old)]);
            $this->db->execute('DELETE FROM auth_challenges WHERE expires_at<=?', [time()]);
            $this->db->execute('INSERT INTO auth_challenges VALUES(?,?,?,?,?,?,?,NULL)', [hash('sha256', $id), hash('sha256', $library->getChallenge()->getBinaryString()), $body->mode, $email === null ? null : $this->state->hash('email', $email), $member['id'] ?? null, $actor, $expires]);
        });
        $this->state->setCookie('sd_auth', $id, $expires);
        return $options;
    }
    public function verify(mixed $input): array
    {
        $this->state->requireOrigin();
        $this->state->rate([['passkey-verify:' . AuthState::ip(), 30, 60]]);
        $cookie = AuthState::cookie('sd_auth');
        // Every submitted ceremony is one-use, including a rejected assertion.
        $challenge = $this->db->transaction(function () use ($cookie): ?array {
            $row = $cookie ? $this->db->one('SELECT * FROM auth_challenges WHERE id_hash=? AND expires_at>? AND used_at IS NULL', [hash('sha256', $cookie), time()]) : null;
            if ($row) $this->db->execute('UPDATE auth_challenges SET used_at=? WHERE id_hash=?', [time(), $row['id_hash']]);
            return $row;
        });
        $this->state->setCookie('sd_auth', '', 1);
        if (!$challenge) throw new ApiError('invalid_credential');
        try {
            $credential = AuthState::object($input, ['id', 'rawId', 'type', 'response', 'clientExtensionResults', 'authenticatorAttachment'], ['id', 'rawId', 'type', 'response']);
            $rawId = AuthState::decode($credential->rawId, 1024);
            if ($credential->id !== $credential->rawId || $credential->type !== 'public-key') throw new ApiError('invalid_credential');
            $response = AuthState::object($credential->response, ['clientDataJSON', 'attestationObject', 'authenticatorData', 'signature', 'userHandle', 'transports', 'publicKey', 'publicKeyAlgorithm'], ['clientDataJSON']);
            $clientJson = AuthState::decode($response->clientDataJSON, 8192);
            $client = json_decode($clientJson, false, 32, JSON_THROW_ON_ERROR);
            if (!$client instanceof \stdClass || ($client->origin ?? null) !== $this->db->config->origin || ($client->crossOrigin ?? false) !== false || isset($client->topOrigin)) throw new ApiError('invalid_credential');
            $actualChallenge = AuthState::decode($client->challenge ?? null, 32);
            if (!hash_equals($challenge['challenge_hash'], hash('sha256', $actualChallenge))) throw new ApiError('invalid_credential');
            $library = $this->library();
            $issued = $this->db->transaction(function () use ($challenge, $credential, $rawId, $response, $clientJson, $actualChallenge, $library): array {
                $recovery = null;
                if ($challenge['mode'] === 'register') {
                    $principal = $this->sessions->authenticate();
                    if (Tokens::actor($principal) !== $challenge['actor']) throw new ApiError('invalid_credential');
                    $known = $this->db->one('SELECT * FROM members WHERE id=?', [$challenge['member_id']]);
                    if (!$known) throw new ApiError('invalid_credential');
                    $member = $this->registrationMember($known['email'], $principal);
                    $data = $library->processCreate($clientJson, AuthState::decode($response->attestationObject ?? null), $actualChallenge, true, true);
                    if ($data->credentialId !== $rawId || $this->db->one('SELECT id FROM passkeys WHERE credential_id=?', [$credential->id])) throw new ApiError('invalid_credential');
                    $transports = $response->transports ?? [];
                    if (!is_array($transports) || count($transports) > 5 || array_filter($transports, static fn(mixed $item): bool => !is_string($item) || !in_array($item, ['usb', 'nfc', 'ble', 'hybrid', 'internal'], true))) throw new ApiError('invalid_credential');
                    $this->db->execute('INSERT INTO passkeys VALUES(?,?,?,?,?,?,?)', [Database::id(), $member['id'], $credential->id, $data->credentialPublicKey, $data->signatureCounter ?? 0, json_encode($transports, JSON_THROW_ON_ERROR), Database::now()]);
                    if (!$this->db->one('SELECT code_hash FROM recovery_codes WHERE member_id=? LIMIT 1', [$member['id']])) {
                        $recovery = [];
                        for ($i = 0; $i < 10; $i++) {
                            $code = strtoupper(implode('-', str_split(bin2hex(random_bytes(12)), 6)));
                            $this->db->execute('INSERT INTO recovery_codes VALUES(?,?,NULL)', [$member['id'], $this->state->hash('recovery', $code)]);
                            $recovery[] = $code;
                        }
                    }
                    $this->db->audit($member['workspace_id'], $member['id'], 'passkey.register', $member['id']);
                } else {
                    $key = $this->db->one('SELECT * FROM passkeys WHERE credential_id=?', [$credential->id]);
                    $member = $key ? $this->db->one('SELECT * FROM members WHERE id=?', [$key['member_id']]) : null;
                    if (!$member || ($challenge['email_hash'] !== null && !hash_equals($challenge['email_hash'], $this->state->hash('email', $member['email'])))) throw new ApiError('invalid_credential');
                    // Discoverable login must bind the returned user handle as well as its credential ID.
                    if (!isset($response->userHandle) || !hash_equals(hex2bin($member['id']), AuthState::decode($response->userHandle, 64))) throw new ApiError('invalid_credential');
                    $library->processGet($clientJson, AuthState::decode($response->authenticatorData ?? null, 8192), AuthState::decode($response->signature ?? null, 8192), $key['public_key'], $actualChallenge, (int) $key['sign_count'], true, true);
                    $this->db->execute('UPDATE passkeys SET sign_count=? WHERE id=?', [$library->getSignatureCounter() ?? 0, $key['id']]);
                }
                $issued = $this->sessions->create($member, 'passkey');
                if ($recovery !== null) $issued['response']['recoveryCodes'] = $recovery;
                return $issued;
            });
            return $this->sessions->finish($issued);
        } catch (WebAuthnException|\JsonException) { throw new ApiError('invalid_credential'); }
    }
}
