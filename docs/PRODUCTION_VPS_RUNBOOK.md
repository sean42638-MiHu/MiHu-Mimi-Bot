# MiHu Production VPS Runbook

Status: **TEMPLATE ONLY — NO VPS, Production DB, DNS, firewall, certificate, or provider account was touched.** Production hostname and credentials are intentionally unspecified. Every command marked DANGEROUS is an operator action and is not part of automated tests.

## A. VPS Preparation

- Owner selects an Ubuntu LTS x64 image and records the exact release/kernel and selected Node 24.x runtime.
- Confirm provider permits two long-running processes on the same VM, durable local block storage, systemd, custom domain/TLS, outbound Discord WebSocket/HTTPS, shell access, and backup extraction.
- Do not create a second VM for Bot while retaining a shared SQLite file. Network filesystems and cross-host SQLite locking are not approved.

## B. Dedicated Service Account

**DANGEROUS — execute only on the approved new VPS.** Create `mihu` as a non-login system user/group; do not use root for either service. Example command contract: `useradd --system --create-home --home-dir /var/lib/mihu --shell /usr/sbin/nologin mihu`.

Ownership/modes:

- `/opt/mihu/app`: `root:mihu`, directories `0750`, ordinary files `0640`, executable scripts retain only required execute bits; service has read/execute but no write.
- `/etc/mihu/mihu.env`, `/etc/mihu/mihu-web.env`, `/etc/mihu/mihu-bot.env`: `root:mihu`, mode `0640`; never world-readable, never copied into the repository.
- `/var/lib/mihu`: `mihu:mihu`, mode `0750`; SQLite DB mode `0640`; data mirror subdirectory mode `0750`.
- `/var/backups/mihu`: `mihu:mihu`, mode `0750`; external backup credentials/access are handled by the owner/provider, not stored in this repo.
- Never use `chmod 777`.

## C. Directories and Initial DB File

**DANGEROUS — provisions Production filesystem paths.** After confirming the provider's attached persistent volume is mounted, create `/opt/mihu/app`, `/etc/mihu`, `/var/lib/mihu/data`, and `/var/backups/mihu` with the ownership above. Do not create these under an ephemeral root filesystem.

The application refuses to create a Production DB. Only after the volume is mounted and the owner has approved the empty initial DB, provision `/var/lib/mihu/database.sqlite` as an empty file with owner `mihu` and mode `0640`. Do not copy repository `database.sqlite`, `mihu.db`, or Development/Test DB into Production.

## D. Permissions

**DANGEROUS — permission changes affect access controls.** Use narrow ownership/modes; verify with `stat`/`namei` without printing env content. The `mihu` account must traverse/read `/opt/mihu/app`, read `/etc/mihu` env files, read/write `/var/lib/mihu` (DB journals and JSON mirrors), and write `/var/backups/mihu`. No other unprivileged account should read secret env files.

## E. Node Installation

Production contract: Node `>=24.0.0 <25`; current Development is Node 24.21.0; sqlite3 6.0.1 declares `>=20.17.0`. Select a supported Node 24 release from the approved OS/package source, verify its signature/provenance per the VPS policy, and record exact `node --version`/architecture. `package.json` has an engines range; do not infer Production platform certification from local tests.

## F. Repository Deployment

**DANGEROUS — changes the application release.** Deploy a reviewed immutable release/commit to `/opt/mihu/app` using the approved deployment mechanism. Keep `/var/lib/mihu`, `/etc/mihu`, and `/var/backups/mihu` outside the checkout. Never run an unrestricted `git pull && npm install && migrate && restart` sequence.

## G. Dependencies

**DANGEROUS — installs native runtime dependencies; run only on the selected VPS/release.** From `/opt/mihu/app`, run `npm ci --prefix mihu-bot-mimi` using the locked manifest. Do not run migration, seed, reset, or Discord registration as an install hook. Verify native sqlite3 loads and the Node major is 24.

## H. Production ENV

Prepare the common env from [`deploy/env/mihu.production.env.example`](../deploy/env/mihu.production.env.example), plus the role files [`mihu-web.env.example`](../deploy/env/mihu-web.env.example) and [`mihu-bot.env.example`](../deploy/env/mihu-bot.env.example). Install under `/etc/mihu/` with the permissions above. Replace every placeholder through the secret/config owner process; no actual secret or domain is specified here.

For Cloudflare-proxied traffic through Nginx, set `TRUST_PROXY_HOPS=2` only after verifying the exact forwarded chain and configuring Nginx to trust/normalize Cloudflare headers. For direct DNS to Nginx, use `1`. Never trust arbitrary `X-Forwarded-*` input.

## I. Persistent Database and Mirrors

- Set `DATABASE_PATH=/var/lib/mihu/database.sqlite` and `PRODUCTION_DATA_DIR=/var/lib/mihu/data` in the verified persistent volume contract; retain separate backup storage at `/var/backups/mihu`.
- Both Web and Bot services must resolve the same DB and data directory on the same host/local filesystem.
- Keep SQLite rollback journal or any WAL/SHM sidecars beside the database. Do not switch journal mode during provisioning; inspect the actual mode read-only in preflight.
- Local `withTransactionGate` is process-local. SQLite locking, not that gate, serializes cross-process writers.

## J. Readiness

`npm run db:readiness` checks config/schema state and reports secrets only as CONFIGURED/MISSING. It does not prove deployment identity, network routing, RBAC, persistent volume durability, or Production readiness. Web/Bot startup runs readonly schema checks and refuses an unprepared DB; startup never migrates.

## K. Backup

**DANGEROUS — creates a Production backup artifact. Run only with change approval and writer freeze.** Stop all Web/Bot/worker/maintenance writers; set one-shot `PRODUCTION_IDENTITY_VERIFIED=YES`, `PRODUCTION_STORAGE_VERIFIED=YES`, `PRODUCTION_WRITES_DISABLED=YES`, `BACKUP_STORAGE_VERIFIED=YES`, and `BACKUP_CONFIRM=YES` in the command environment (not committed config). Set `DATABASE_BACKUP_DIR` to verified external/local backup storage, then run `npm run db:backup`.

The command creates a timestamped SQLite backup plus manifest containing source identity hash, source/backup SHA-256, timestamp and integrity result; it does not print DB paths or data and does not prune old backups. Copy/replicate the verified backup off-host using the approved provider tooling, then verify that copy independently.

## L. Explicit Migration

**DANGEROUS — writes schema/data. Requires separate approval.** With every writer stopped and a verified pre-migration backup, set `MIGRATION_CONFIRM=YES`, `MIGRATION_BACKUP_MANIFEST` to the verified manifest, and Production identity/storage/writer-freeze confirmations. Run `npm run db:migrate` once. Non-zero exit means stop; do not start Web/Bot. Web/Bot startup and deploy hooks must never execute migrations.

## M. systemd

Review [`mihu-web.service`](../deploy/systemd/mihu-web.service) and [`mihu-bot.service`](../deploy/systemd/mihu-bot.service). Install as root only after replacing the release/paths as owner-approved; each uses `User=mihu`, `Group=mihu`, strict read-only code, state/backup write paths, restart-on-failure and SIGTERM shutdown. Web is loopback-bound; Bot starts `botRunner.js` only. Neither unit runs migrations or command registration.

**DANGEROUS — enables Production services.** After readiness/migration approval, install unit files, run `systemctl daemon-reload`, then enable/start Web and Bot as two independent services. Do not start Bot until the Production Guild/token owner confirms scope.

## N. Nginx

Review [`mihu.conf.example`](../deploy/nginx/mihu.conf.example). It listens on port 80 for challenge/redirect and shows a TLS server template; certificate paths and `server_name` are placeholders. Replace them only after domain/certificate approval. Proxy to `127.0.0.1:3000`, pass Host/Real-IP/Forwarded-For/Forwarded-Proto, apply the 10 MiB request limit and bounded timeouts. Express is not intended to be publicly reachable directly; static files remain served by Express.

## O. HTTPS

Provision origin TLS with the approved certificate authority/secret process. Verify HTTPS, HTTP→HTTPS redirect, certificate renewal, secure cookie behavior and proxy headers. No ACME request/certificate issuance was performed in this phase.

## P. DNS / Cloudflare

No hostname is selected. Owner maps DNS A/AAAA to the VPS only after address allocation. If Cloudflare proxy is enabled, verify TLS mode is Full (strict), origin Nginx serves a trusted certificate, and forwarded headers are restricted to Cloudflare ranges at the firewall/Nginx layer. Do not enable proxy/DNS until origin HTTPS and trust-proxy hop count are verified. No Cloudflare API/DNS action was performed.

## Q. OAuth Callback

After the real HTTPS domain is selected, set `PUBLIC_BASE_URL=https://<approved-domain>` and `DISCORD_CALLBACK_URL=https://<approved-domain>/auth/discord/callback`; manually add exactly the same redirect URI in Discord Developer Portal. Confirm CSRF/state, session persistence and return URL behavior through an approved test account. No OAuth was executed and the Portal was not changed.

## R. Web Verification

Check `systemctl status mihu-web`, `journalctl -u mihu-web`, local `curl http://127.0.0.1:3000/healthz`, HTTPS ingress, static assets, login/session, secure cookie, and Nginx proxy headers. `/healthz` is liveness only; it does not assert DB/RBAC readiness.

## S. Bot Verification

Check `systemctl status mihu-bot` and `journalctl -u mihu-bot`. Verify Gateway readiness and intended Guild scope with an approved Test Guild before Production. The service opens no HTTP listener. Command registration/clear remains disabled unless separately approved and explicitly invoked.

## T. Production Preflight

From a verified Production runtime, after manually confirming the instance and persistent volume, set one-shot `PRODUCTION_IDENTITY_VERIFIED=YES`, `PRODUCTION_STORAGE_VERIFIED=YES`, `PRODUCTION_PREFLIGHT_CONFIRM=YES`; run `npm run db:preflight`. It opens SQLite `OPEN_READONLY`, reports admin/effective permission checks, unknown permissions, role assignments, explicit wildcard roles and journal mode. PASS is necessary evidence, not proof of uptime, deployment provenance, domain/TLS, backups or external platform identity; retain the report in the approved change record.

## U. RBAC Verification

Require Production preflight PASS, confirm the effective break-glass resolver user exists, inspect admin permissions and unknown keys, and verify expected operator assignments. `db:readiness` PASS or a healthy page does not mean RBAC verified. Do not automatically add `*` or alter Production role JSON.

## V. Rollback

Stop both systemd services, maintain ingress/write freeze, preserve logs/manifest, and deploy only the previous reviewed compatible release. Never point an older binary at a DB with a newer schema without explicit compatibility approval. Do not run migration as part of rollback.

## W. Restore

**DANGEROUS — replaces the Production DB file. Requires incident/restore approval.** Stop both services, verify external DB identity and backup checksums, create a fresh pre-restore backup, confirm no `-wal`/`-shm`/journal sidecars or active handles, then run `npm run db:restore` with restore-source and pre-restore manifests and explicit confirmation. Verify integrity/schema/readiness and read-only reconciliation before restart. Off-host backup copy must remain untouched.

## X. Emergency Stop

**DANGEROUS — stops Production services.** Use `systemctl stop mihu-web mihu-bot`; apply provider/firewall ingress restriction if Web must be isolated. Confirm both processes are stopped before any DB migration/restore. Preserve `/var/lib/mihu`, `/var/backups/mihu`, and journal logs. No firewall/systemd command was executed by this runbook authoring task.
