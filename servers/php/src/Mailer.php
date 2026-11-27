<?php
declare(strict_types=1);
namespace StepDoc;

use PHPMailer\PHPMailer\PHPMailer;

final class Mailer
{
    public function enabled(): bool { return (getenv('STEPDOC_MAIL_FROM') ?: '') !== ''; }
    public function sendCode(string $email, string $code): void
    {
        if (!$this->enabled()) throw new ApiError('mail_unavailable', 503);
        try {
            $mail = new PHPMailer(true);
            $mail->CharSet = 'UTF-8';
            $mail->SMTPDebug = 0;
            $mail->Timeout = 5;
            $mail->Timelimit = 10;
            $mail->setFrom(getenv('STEPDOC_MAIL_FROM'), 'StepDoc');
            $mail->addAddress($email);
            $mail->Subject = 'Your StepDoc sign-in code';
            $mail->Body = "Your StepDoc sign-in code is: " . $code . "\n\nIt expires in 10 minutes and can be used once. If you did not request it, ignore this email.";
            $host = getenv('STEPDOC_SMTP_HOST') ?: '';
            if ($host !== '') {
                if (!preg_match('~^(?:[a-zA-Z0-9.-]+|\[::1\])$~D', $host)) throw new ApiError('invalid_options', 503);
                $mail->isSMTP();
                $mail->Host = $host;
                $security = getenv('STEPDOC_SMTP_SECURITY') ?: 'starttls';
                if (!in_array($security, ['starttls', 'smtps', 'none'], true) || ($security === 'none' && !in_array($host, ['localhost', '127.0.0.1', '[::1]'], true))) throw new ApiError('invalid_options', 503);
                $port = getenv('STEPDOC_SMTP_PORT') ?: ($security === 'smtps' ? '465' : '587');
                if (!ctype_digit($port) || (int) $port < 1 || (int) $port > 65535) throw new ApiError('invalid_options', 503);
                $mail->Port = (int) $port;
                $mail->SMTPSecure = $security === 'none' ? '' : ($security === 'smtps' ? PHPMailer::ENCRYPTION_SMTPS : PHPMailer::ENCRYPTION_STARTTLS);
                $mail->SMTPAutoTLS = $security !== 'none';
                $mail->Username = getenv('STEPDOC_SMTP_USERNAME') ?: '';
                $mail->Password = getenv('STEPDOC_SMTP_PASSWORD') ?: '';
                $mail->SMTPAuth = $mail->Username !== '';
            }
            $mail->send();
        } catch (\Throwable) { throw new ApiError('mail_unavailable', 503); }
    }
}
