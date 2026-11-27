# Private PHP recovery points

StepDoc takes one daily backup on the first normal app or API request after
midnight **UTC**, once a workspace exists. It requires no cron or daemon. The
request that wins a nonblocking filesystem lock does the work; other requests
continue. Failure keeps the live data and earlier completed points intact, shows a
generic `/health` warning and retries after five minutes. An explicit local backup
command can retry immediately. An initial installation does not back up before
owner enrollment completes.

Backups live under the private data directory at `backups/<id>/`. They contain:

- `data/stepdoc.sqlite`: a consistent snapshot including committed WAL data, all
  workspaces, guides, immutable history, trash and authentication records.
- `data/blobs/*`: independent copies of every committed blob, with original bytes,
  sizes and hashes preserved. No image is decoded or transformed.
- `data/auth.key`: the private HMAC key needed to recover sign-in state.
- `stepdoc.config.json`: canonical origin and API prefix, without SMTP or other
  environment secrets.
- `manifest.jsonl`: a versioned streaming inventory of file sizes/SHA-256 hashes,
  plus a checksum and completion footer. It does not contain raw credentials.

The SQLite copy uses [VACUUM INTO](https://www.sqlite.org/lang_vacuum.html#vacuum_with_an_into_clause)
instead of copying the live database/WAL files. Incomplete upload staging is
removed **from the copy only**; the extension retains its capture and can resend.
Committed capture receipts remain, preserving idempotent retries. The backup
copies immutable committed blob files and checks them against the snapshot's
metadata. Files and the manifest are [synced](https://www.php.net/manual/en/function.fsync.php)
before the private staging directory is renamed into a completed point. A later
request removes abandoned staging directories and can adopt an already completed
rename after an interrupted status write.

Keep the whole data directory outside the document root. Backup files include
private guide content and authentication material; they are not a public export.
Path boundaries are rechecked with a fresh [PHP filesystem/realpath cache](https://www.php.net/manual/en/function.clearstatcache.php)
so a long-lived worker cannot reuse a stale directory mapping after a swap.
The server provides no HTTP backup download or administration endpoint. Health
reports only success/warning, never backup paths, IDs, keys or filesystem errors.
Checksums detect damaged or incomplete copies; the files are not encrypted or
signed. Host credentials and any off-host copy remain the operator's configuration.

## Local commands

Use the same data/origin/API environment as the server. Commands read JSON from
stdin and print bounded metadata, never keys or file contents:

```powershell
'{}' | php bin/stepdoc.php backup:create
'{}' | php bin/stepdoc.php backup:list
'{"id":"2026-11-27T000000Z-0123456789abcdef"}' | php bin/stepdoc.php backup:verify
```

`backup:create` creates an additional manual point. Retention keeps the **seven
latest successful points in total**, including manual points, always retaining
the newly created one. Only recognized completed backup directories are pruned;
failed attempts never prune an earlier point. Unrecognized files are left alone.
List results are completion metadata; `backup:verify` reads and hashes every file,
rejects duplicate/unsafe paths or extra files, checks SQLite integrity and foreign
keys, and checks that every committed blob matches its database record. A failed
command returns only a fixed error. No raw exception or credential is printed.

## Restore into an empty private installation

Stop writes while switching a serving installation. Verify the selected point
first and preserve the existing installation and recovery points separately.
Copy the point's `data/` into an **empty** private replacement data directory; do
not merge or overwrite a live SQLite database or its WAL. Copy its
`stepdoc.config.json` above the new installation's `public/`, or supply the matching
canonical origin/API environment. The package's `public/` remains the document
root. Preserve/reconfigure host-only settings such as SMTP separately.

Point `STEPDOC_DATA_DIR` at that replacement directory (or swap directories while
the server is stopped). StepDoc applies its normal migrations when opening it.
The next normal request creates a new private recovery point. Keep the original
backup until the restored installation has been verified. Automated tests perform
this fresh-directory recovery against real PHP, native WebAuthn/recovery codes,
history, committed capture retry and byte-identical large blobs.

Authentication is restored to the point's time too: later revocations or consumed
codes are not present in an older copy. Restore privately and apply the account's
credential recovery procedure before making it available. This is a recovery
operation, not a way to merge two active servers.
