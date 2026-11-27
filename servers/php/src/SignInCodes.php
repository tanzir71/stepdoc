<?php
declare(strict_types=1);
namespace StepDoc;

final class SignInCodes
{
    public function __construct(private readonly Database $db, private readonly AuthState $state, private readonly Sessions $sessions, private readonly Mailer $mailer) {}
    public function request(mixed $input): void
    {
        $this->state->requireOrigin();
        $body = AuthState::object($input, ['email'], ['email']);
        $email = AuthState::email($body->email);
        if (!$this->mailer->enabled()) throw new ApiError('mail_unavailable', 503);
        $this->state->rate([['mail-ip:' . AuthState::ip(), 10, 600], ['mail-email:' . $email, 3, 600]]);
        $emailHash = $this->state->hash('email', $email);
        $member = $this->db->one('SELECT id FROM members WHERE email=? COLLATE NOCASE', [$email]);
        $code = str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);
        $codeHash = $this->state->hash('login:' . $emailHash, $code);
        // Unknown addresses use the same state/response path and cannot authenticate.
        $this->db->execute('INSERT INTO login_codes VALUES(?,?,?,0) ON CONFLICT(email_hash) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at,attempts=0', [$emailHash, $codeHash, time() + 600]);
        if ($member) {
            try { $this->mailer->sendCode($email, $code); }
            catch (ApiError) {
                $this->db->execute('DELETE FROM login_codes WHERE email_hash=? AND code_hash=?', [$emailHash, $codeHash]);
                // A broken mailbox must not turn this route into an address oracle.
            }
        }
    }
    public function verify(mixed $input, bool $recovery = false): array
    {
        $this->state->requireOrigin();
        $body = AuthState::object($input, ['email', 'code'], ['email', 'code']);
        $email = AuthState::email($body->email);
        $this->state->rate([['code-ip:' . AuthState::ip(), 30, 600], ['code-email:' . $email, 10, 600]]);
        if (!is_string($body->code) || !preg_match($recovery ? '~^[A-F0-9]{6}(?:-[A-F0-9]{6}){3}$~D' : '~^[0-9]{6}$~D', $body->code)) throw new ApiError('invalid_code');
        $issued = $this->db->transaction(function () use ($email, $body, $recovery): ?array {
            $member = $this->db->one('SELECT * FROM members WHERE email=? COLLATE NOCASE', [$email]);
            if ($recovery) {
                $codeHash = $this->state->hash('recovery', $body->code);
                $row = $member ? $this->db->one('SELECT code_hash FROM recovery_codes WHERE member_id=? AND code_hash=? AND used_at IS NULL', [$member['id'], $codeHash]) : null;
                if (!$row) return null;
                $this->db->execute('UPDATE recovery_codes SET used_at=? WHERE member_id=? AND code_hash=?', [time(), $member['id'], $codeHash]);
            } else {
                $emailHash = $this->state->hash('email', $email);
                $row = $this->db->one('SELECT * FROM login_codes WHERE email_hash=?', [$emailHash]);
                if (!$row || (int) $row['expires_at'] <= time() || (int) $row['attempts'] >= 5) return null;
                $this->db->execute('UPDATE login_codes SET attempts=attempts+1 WHERE email_hash=?', [$emailHash]);
                if (!$member || !hash_equals($row['code_hash'], $this->state->hash('login:' . $emailHash, $body->code))) return null;
                $this->db->execute('DELETE FROM login_codes WHERE email_hash=?', [$emailHash]);
            }
            return $this->sessions->create($member, $recovery ? 'recovery' : 'email');
        });
        if (!$issued) throw new ApiError('invalid_code');
        return $this->sessions->finish($issued);
    }
}
