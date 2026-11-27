# Install StepDoc on PHP shared hosting

Build locally with `pnpm install --frozen-lockfile`, `pnpm --filter @stepdoc/php setup`,
then `pnpm build:php`. The build uses the locked PHP dependencies and compiles the
shared client. The host needs PHP 8.1+, OpenSSL and PDO SQLite; it runs without Node,
Composer, daemons or image-processing extensions. The local ZIP builder also needs
PHP's ZIP extension. Nothing is deployed by the build or tests.

The build produces `dist/stepdoc-php.zip` and a separate private
`dist/stepdoc-php-install-key.txt`. Keep the key locally. It is never included in the
archive, printed by the build, or stored in a client bundle. A fresh build generates
a new key. Do not upload the key file into any public directory.

1. Extract the ZIP into an account directory such as `~/stepdoc`.
2. Set the site's document root to `~/stepdoc/public`. Keep `src`, `vendor`, `app`,
   `schema`, configuration and `data` outside the document root. Enable Apache
   rewrite/override support for `public/.htaccess`; directory listing is disabled.
   The outer `.htaccess` denies accidental public access to the private folder.
3. Use HTTPS and a DNS hostname. Passkeys cannot use an IP-address RP ID.
4. Open `/setup` (or `/install.php`). Check the reported host capabilities, choose
   Shared hosting and Continue, then enter the private setup key.
5. Enter the workspace, owner name and email, create the owner passkey and save the
   ten recovery codes shown once. The temporary enrollment token expires after ten
   minutes and is revoked after registration. Setup cannot create another owner
   after enrollment, even if the archive is uploaded again.
6. Follow the extension source-install link and create a pairing code when ready.
   The existing extension pairing screen accepts the installation's API URL and
   this five-minute code. Open the workspace to create/import guides.

An explicit This browser choice opens a separate browser-only workspace. It uses
IndexedDB/OPFS and makes no Storage API requests; hosted failures never choose that
mode automatically. Cloudflare/Node and GitHub publishing remain separate targets
under development; they do not provision a PHP installation.

For a subdirectory, serve this public folder at that prefix. Setup records its
canonical origin and API prefix privately in `stepdoc.config.json`. Apache rewrites
must preserve the installation's script prefix. For local automated development:

```powershell
$env:STEPDOC_API_PATH='/tools/api/v1'
php -S localhost:8080 -t stepdoc/public stepdoc/router.php
```

Open `http://localhost:8080/tools/setup`. Localhost HTTP is an explicit development
exception; host checks report it as such. Production requires HTTPS. Cookies remain
Secure, HttpOnly and scoped to the installation. An interrupted setup can resume by
entering its key again; a new claim revokes the prior temporary enrollment token.

Configure SMTP outside the web root with `STEPDOC_MAIL_FROM`, `STEPDOC_SMTP_HOST`,
`STEPDOC_SMTP_PORT`, `STEPDOC_SMTP_USERNAME`, `STEPDOC_SMTP_PASSWORD` and
`STEPDOC_SMTP_SECURITY=starttls|smtps`. Without configured email delivery, passkeys and
the saved recovery codes remain available. No secrets are written to app logs.

Preserve `data/` and `stepdoc.config.json` when upgrading. Daily private recovery
points run lazily after midnight UTC and keep seven successful points. Use the
local `backup:create`, `backup:list` and `backup:verify` commands; see
[BACKUPS.md](BACKUPS.md) for the complete layout and fresh-directory recovery.
Never copy or overwrite a live database/WAL when restoring.

`manifest.json` records packaged file hashes. Runtime credentials, configuration,
databases, uploaded images, development fixtures and Node dependencies are excluded.
The automated installer suite extracts the actual archive and runs PHP plus a
Chromium virtual authenticator locally. No owner testing or live host is required.
