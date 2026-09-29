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

**DANGEROUS — installs native runtime dependencies; run only on the selected VPS/release.** From `/opt/mihu/app` (the repository root is the application root), run `npm ci` using the locked manifest. Do not run migration, seed, reset, or Discord registration as an install hook. Verify native sqlite3 loads and the Node major is 24.

## H. Production ENV

Prepare the common env from [`deploy/env/mihu.production.env.example`](../deploy/env/mihu.production.env.example), plus the role files [`mihu-web.env.example`](../deploy/env/mihu-web.env.example) and [`mihu-bot.env.example`](../deploy/env/mihu-bot.env.example). Install under `/etc/mihu/` with the permissions above. Replace every placeholder through the secret/config owner process; no actual secret or domain is specified here.

For Cloudflare-proxied traffic, Nginx must resolve the client with `set_real_ip_from <current Cloudflare ranges>` + `real_ip_header CF-Connecting-IP` at the `http` level and overwrite `X-Forwarded-For $remote_addr` (not `$proxy_add_x_forwarded_for`). With that design Express sees exactly one hop, so use `TRUST_PROXY_HOPS=1`; the same value applies to direct DNS. Never trust arbitrary `X-Forwarded-*` input.

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

Before a `GO_LIVE` preflight PASS (section T), `mihu-web` may run only under the restricted exception in U.2, and `mihu-bot` must not run.

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

`PRODUCTION_PREFLIGHT_MODE` selects what `status: PASS` means:

| Mode | PASS requires | Meaning |
|---|---|---|
| `INITIALIZATION` | Integrity, schema, busy timeout, `admin` operational capabilities including every payout duty (`payout.view`, `payout.view_sensitive`, `payout.export`, `payout.mark_paid`, `payout.reject`), each duty held by an eligible non-wildcard role, no wildcard role, break-glass user row present with stored role `member` or `admin`, valid assignments. Roles combining payout approval and execution are reported in `payoutDuties.combinedDutyRoles` (business-approved for `admin`), not failed. | Structure is correct. **Never a GO.** Staffing may be zero. |
| `GO_LIVE` (default) | Everything above **plus** the break-glass user's stored role is `admin` and every studio has at least one `admin`-assigned user (the break-glass principal counts). | RBAC evidence for the Go/No-Go gate only. |

The report always contains `goLive.rbac` (`NO_GO` or `RBAC_STAFFED`) and `goLive.declared: false`; preflight never declares GO. Staffing of zero is always `NO_GO` in either mode.

## U. RBAC Initialization and Verification

Require Production preflight PASS, confirm the effective break-glass resolver user exists, inspect admin permissions and unknown keys, and verify expected operator assignments. `db:readiness` PASS or a healthy page does not mean RBAC verified. Do not automatically add `*` or alter Production role JSON.

### U.1 Role bootstrap (empty `roles` table only)

**DANGEROUS — writes the Production `roles` table once. Requires change approval.** The only approved role source is [`deploy/rbac/production-roles.json`](../deploy/rbac/production-roles.json); its `approval.status` must be changed to `APPROVED` (with approver and change record) through a reviewed commit before use. With Web and Bot stopped, create a fresh backup (`npm run db:backup`), then run `npm run db:rbac-bootstrap` with `RBAC_BOOTSTRAP_CONFIRM=YES`, `RBAC_BOOTSTRAP_BACKUP_MANIFEST=<that manifest>`, `PRODUCTION_WRITES_DISABLED=YES`, `BACKUP_STORAGE_VERIFIED=YES` and the Production identity/storage confirmations. The script refuses when `roles` is non-empty, the manifest does not match the current DB file, the schema is not migrated, or the definition violates the payout duty policy. It inserts roles and one `RBAC_BOOTSTRAP` audit row only; it never migrates and never creates users.

Effective granular permissions of the initialization-relevant roles (computed from the roles file by the permission resolver; the break-glass principal additionally resolves to `*` from `PLATFORM_SUPERUSER_ID` regardless of stored role). The Production roles file defines 6 roles: `admin`, `aftersales`, `manager`, `cs`, `talent`, `member`.

| Permission | Risk | `admin` 店長兼財務 | `member` 會員 |
|---|---|---|---|
| `system_health.view`, `audit_logs.view`, `system_settings.view`, `system_settings.manage`, `discord_control.view` | low–high | Y | — |
| `analytics.view` | low | Y | — |
| `members.view`, `members.manage`, `member_ledger.view` | low–high | Y | — |
| `roles.view`, `roles.manage` | medium/high | Y | — |
| `staff.view`, `staff.manage`, `staff.view_sensitive` | low–high | Y | — |
| `vip.view`, `vip.manage`, `orders.view`, `orders.manage`, `orders.price_adjust`, `orders.refund`, `orders.refund_completed` | low/high | Y | — |
| `payroll.view` | high | Y | — |
| `payout.view`, `payout.view_sensitive`, `payout.export`, `payout.mark_paid`, `payout.reject` | high | Y | — |
| `commission.view`, `commission.manage`, `payroll.manage` | medium/high | — | — |
| `discord_commands.deploy_dev`, `discord_commands.deploy_production` | high | — | — |

Stored legacy keys (route gates that are not granular): `admin` — `home, personal, profile, my_wallet, my_income, my_orders, manage, manage_members, manage_staff, manage_orders, system, sys_vip, sys_roles, sys_settings, member_adjust_balance, member_adjust_vip, staff_view_payroll, staff_edit_role_commission, orders_edit_and_reassign`; `member` — `home, home_wallet_card, home_info, personal, profile, profile_nickname, my_wallet, my_orders`. Studio commission editing is available to the owner of studio 1 (the break-glass principal) without `commission.manage`.

`cfo` is intentionally not defined in Production. Remaining code references are display or filter only and fail closed without a `cfo` row: the hard-coded `cfo` option in `views/modals/member_modals.ejs` (assignment is refused by `authorizeRoleAssignment` because the role row does not exist), the `財務長` → `cfo` key mapping for new roles in `routes/system.js`, badge metadata in `utils/roleHelper.js`, and `role IN (...)` staff-list filters in `routes/orders.js`, `routes/management/orders.js` and `routes/management/staff.js`. Safer follow-up (separate change): render the role options from the `roles` table instead of the hard-coded list.

### Order permissions and Bot release gate

| Production role | `orders.view` | `orders.manage` | `orders.price_adjust` | `orders.refund` | `orders.refund_completed` |
|---|---:|---:|---:|---:|---:|
| `admin` 店長兼財務 | Y | Y | Y | Y | Y |
| `aftersales` 售後 | Y | Y | — | Y | — |
| `manager` 客服主管 | Y | Y | — | — | — |
| `cs` 客服 | Y | Y | — | — | — |
| `talent`, `member` | Personal orders only | — | — | — | — |

`orders.view` does not grant mutations or refunds; `orders.manage` permits non-refund order operations and implies view only. Neither `orders.manage` nor legacy `manage_orders` grants `orders.price_adjust`; this separate permission is required for changes to order price terms, including price changes during reassignment. `orders.refund` is separately required by single cancel, legacy `is_delete`, and batch-delete routes. `orders.refund_completed` is an additional approval permission held only by `admin`. After-sales refunds are full refunds of unfinished orders only. Completed-order full refunds require the store manager (`admin`) to approve and execute them; no partial-refund path is enabled. Do not add a partial-refund workflow until it is safely tied to a specific order and auditable. The Web routes enforce these permissions independently of the Bot.

Grant Discord guild Administrator permission only to the store manager (`admin`). Keep `mihu-bot` stopped: `/topup` still needs authorization revalidation at submission time and `/abandon_order` still needs studio-scope enforcement. Do not treat this role-file change as approval to start the Bot.

### U.2 Restricted Web OAuth initialization exception

This is the **only** approved case in which `mihu-web` may run before a `GO_LIVE` preflight PASS. It exists because users can only be created by Discord OAuth.

Entry conditions (all required):

- Change record approves the exception, names the break-glass owner (currently the single 店長兼財務, who is `PLATFORM_SUPERUSER_ID`), and sets a time-boxed window.
- U.1 committed; `INITIALIZATION` preflight shows every check passing except `breakGlassUserPresent: NO`.
- `mihu-bot` is stopped and remains stopped. No payout, wallet, order, member-balance or settings mutation is performed during the window.
- Origin HTTPS works and `DISCORD_CALLBACK_URL` matches the Discord Developer Portal redirect.

Access restrictions (for the whole window):

1. **Network layer (Nginx).** Install [`mihu-rbac-initialization.conf.example`](../deploy/nginx/mihu-rbac-initialization.conf.example) in place of the normal site. It proxies only the paths in the table below (method-restricted) and returns 503 for every other path. Choose one access mode:
   - **A. SSH tunnel (preferred).** Only connections whose real TCP peer (`$realip_remote_addr`) is VPS loopback pass. Each named person needs an individually issued SSH key; identity is the SSH key, not an address. **Blocked with the current origin certificate** — see U.3.
   - **B. Named egress addresses via Cloudflare (approved 2026-09-28; procedure U.4).** `allow` lists compared with `$remote_addr` after real-IP resolution. See the limits below.
2. **Application layer.** Set `MIHU_RBAC_INITIALIZATION_WINDOW=true` in `/etc/mihu/mihu-web.env` for the window only. [`middleware/initializationWindowGuard.js`](../middleware/initializationWindowGuard.js) runs before every router and returns 503 for any route not in the table, independent of Nginx.
3. `mihu-bot` stays stopped; the Web process makes no Discord Gateway login.

| Route | Method | Who (application guard) | Effect |
|---|---|---|---|
| `/login`, `/logout` | GET | anyone reaching Nginx | Session only |
| `/auth/discord`, `/auth/discord/callback`, `/auth/login-transition` | GET | anyone reaching Nginx | Callback creates a `member` user row (or updates username/global_name/avatar), writes `discord_identity_register`/`discord_identity_update` audit, rewrites the `users.json` mirror |
| `/management/members` | GET | break-glass principal only | Read-only member list (includes balances and stored profile columns) |
| `/management/members/update-vip/:id` | POST (CSRF) | break-glass principal only, and only when `:id` is the principal itself, its current stored role is `member` (or empty), current VIP is 0, the requested role is exactly `admin`, and `vip_level` is empty or `0`. Any other target, role or VIP value is refused with 403; once the role is `admin` every further request is refused. | Updates own `role` to `admin` (VIP stays 0) and writes `member_vip_role_update` + `ROLE_ASSIGNED` audit with before/after role |
| static `/css/`, `/js/`, `/images/`, `/healthz` | GET | served before the guard | No state change; `/healthz` is not exposed by the initialization Nginx template |

What this does **not** guarantee (record acceptance in the change record):

- Anyone who can reach Nginx can complete Discord OAuth and create a `member` row; there is no Guild membership check. Mode A limits this to SSH key holders; mode B to whoever shares an allowed egress.
- An IP address is a network egress, not a person (CGNAT, shared office/VPN, dynamic IPv6, mobile). Mode B cannot identify named individuals; identity comes only from Discord OAuth, the break-glass-only guard and the audit review.
- Mode B trusts whatever address a peer inside `set_real_ip_from` asserts. That is sound only while the Cloudflare range list is current (refresh it from Cloudflare at window start) and Cloudflare itself sets `CF-Connecting-IP`. Origin reachability from non-Cloudflare networks and host firewall (`ufw`/`nft`) state require sudo to inspect and are **not verified** by this runbook; a direct non-Cloudflare peer keeps its own address, so a forged header does not pass.
- The role-assignment endpoint is shared with VIP editing; the guard requires the principal's own VIP to be 0 and `vip_level` empty/`0`, so VIP cannot change.
- No other user can be given a role or VIP change during the window; additional operators require a separate, later change.
- Two concurrent self-assignment requests can both pass the guard before either commits; the route's transaction then leaves the role `admin` and writes at most one `ROLE_ASSIGNED` row, but an extra `member_vip_role_update` row is possible. Audit review must account for it.
- Self-assignment is gated on `isPlatformSuperuserId(session user)`. The session user comes only from a completed Discord OAuth login (Passport stores the Discord ID; the row is re-read on every request), so an ordinary user cannot reach this path. Outside the window the normal route still applies `authorizeRoleAssignment`, which forbids assigning a role with permissions the actor does not hold.
- After self-assignment the break-glass principal holds `admin` in the DB. Removing `PLATFORM_SUPERUSER_ID` from env no longer revokes all access; revocation also requires changing that user's stored role.

Exit conditions:

- **Success:** the break-glass principal logs in via Discord OAuth, then assigns its own `member` role to `admin` from `/management/members` (VIP left at 0). `INITIALIZATION` preflight PASS, then `GO_LIVE` preflight PASS with `breakGlassStoredRole: ADMIN` and `goLive.rbac: RBAC_STAFFED`. Review audit rows created during the window (expected: one `discord_identity_register`, then `member_vip_role_update` + `ROLE_ASSIGNED` with operator = target = the principal, role `member` → `admin`) and confirm the user count equals the expected named accounts. Retain both reports. Then remove `MIHU_RBAC_INITIALIZATION_WINDOW`, stop `mihu-web`, and restore the normal Nginx site only as part of go-live after every other GO_LIVE_RUNBOOK gate is signed.
- **Abort:** window expires, an unexpected user/audit row appears, or any other action is required → `systemctl stop mihu-web`, keep the initialization Nginx site in place, record the incident. Do not delete rows ad hoc; remediation needs separate approval.
- After success the same person operates daily as `admin`; the env-level break-glass authority remains in place and is not a separate account.

### U.3 Mode A TLS prerequisite and Windows procedure

Verified 2026-09-28 (public certificate fields only):

- Origin Nginx presents a **Cloudflare Origin CA** certificate (SAN `mihugaming.com.tw`, `*.mihugaming.com.tw`). It is trusted only by Cloudflare's edge, not by browsers (`openssl` verify code 21). Through a tunnel that bypasses Cloudflare, a browser will show a certificate error for the production URL.
- The Cloudflare edge presents a publicly trusted certificate; that is why mode B works without certificate changes.
- `PUBLIC_BASE_URL` and `DISCORD_CALLBACK_URL` are HTTPS, same origin, apex host matching Nginx `server_name`, default port, callback path `/auth/discord/callback`. Discord redirects the browser to that URL, so the browser (not Discord) must resolve it to the tunnel.
- Session cookie is `Secure`, `HttpOnly`, `SameSite=Lax`; Nginx sends `X-Forwarded-Proto https` and `TRUST_PROXY_HOPS=1`, so the cookie is issued through the tunnel, and the Lax cookie is sent on Discord's top-level GET redirect back.

Do **not** bypass the certificate warning and do **not** trust the Cloudflare Origin CA in the OS or browser store. Mode A requires, as a separately approved Production change:

1. A publicly trusted certificate for the apex host (ACME DNS-01 with a Cloudflare API token scoped to DNS edit for this zone only; HTTP-01 is unreliable because the 443 site does not serve `/.well-known`), with automated renewal and a Nginx reload hook.
2. A separate Nginx server block listening only on `127.0.0.1:8443` with that certificate, the initialization locations and the mode A peer check. The public 443 site keeps the Origin CA certificate, so Cloudflare traffic is unchanged.
3. A tunnel-only SSH account for the break-glass owner: individual key, `restrict,port-forwarding,permitopen="127.0.0.1:8443"` in `authorized_keys`, no shell.

Windows procedure once 1–3 exist:

1. Verify the VPS SSH host-key fingerprint out of band, then `ssh -N -L 127.0.0.1:443:127.0.0.1:8443 <tunnel-user>@<vps-address>` (built-in OpenSSH). Confirm nothing else listens locally: `netstat -ano | findstr "127.0.0.1:443"`.
2. Start a dedicated, throw-away browser profile that maps only this host to the tunnel, without editing the hosts file or any trust store: `msedge.exe --user-data-dir="%TEMP%\mihu-init" --host-resolver-rules="MAP mihugaming.com.tw 127.0.0.1" https://mihugaming.com.tw/login`. Other hosts (including discord.com) resolve normally.
3. Verify before logging in: no certificate warning; certificate issuer is the public CA from step 1 (not Cloudflare Origin CA); DevTools response headers have **no** `cf-ray`/`server: cloudflare` (proves the tunnel path); `/dashboard` returns the `RBAC initialization window` 503 text.
4. Log in with Discord; the browser returns to `/auth/discord/callback` through the tunnel. In DevTools confirm the session cookie is `Secure`, `HttpOnly`, `SameSite=Lax`.
5. Assign own role to `admin` at `/management/members` (VIP 0). Close the profile, delete `%TEMP%\mihu-init`, stop the tunnel.

If changes 1–3 are not approved, **switch to mode B**: it works with the existing edge certificate, and the application guard still limits the window to OAuth login plus the single self-assignment; the residual risk is that anyone behind an allowed egress address can create a `member` row.

### U.4 Mode B operating procedure (approved)

Every `sudo` step is run by the owner in their own terminal. Commands never print env values. Run production scripts as `mihu` with the service env files, so no secret is placed on a command line:

```sh
MIHU_RUN() { sudo systemd-run --quiet --wait --pipe --collect --uid=mihu --gid=mihu \
  -p WorkingDirectory=/opt/mihu/app -p EnvironmentFile=/etc/mihu/mihu.env -p EnvironmentFile=/etc/mihu/mihu-web.env \
  --setenv=PRODUCTION_IDENTITY_VERIFIED=YES --setenv=PRODUCTION_STORAGE_VERIFIED=YES "$@"; }
PREFLIGHT() { MIHU_RUN --setenv=PRODUCTION_PREFLIGHT_CONFIRM=YES --setenv=PRODUCTION_PREFLIGHT_MODE="$1" /usr/bin/node scripts/productionPreflight.js; }
```

**Global abort:** at any abort condition run `sudo systemctl stop mihu-web` (if started), leave the initialization Nginx site in place (or do not install it yet), record the step, output and time, and stop. Never edit, delete, migrate or restore the DB as part of an abort.

**Address-change rule:** re-run the step 1 trace commands immediately before steps 9, 12, 13 and 14. If either recorded address differs, apply the global abort. Resume only after re-verifying the new address, updating the change record and the access snippet (still an exact IPv4 `/32` and IPv6 `/128`), and restarting from step 9. Never widen IPv6 to a `/64` or any other prefix.

| # | Action | Expected result | Abort if |
|---|---|---|---|
| 0 | Owner, locally: record the change ID and window; commit `approval.status: APPROVED` (+ `approvedBy`, `changeRecord`) in `deploy/rbac/production-roles.json`; confirm the Discord Developer Portal redirect list contains exactly `DISCORD_CALLBACK_URL`; confirm your Discord user ID equals `PLATFORM_SUPERUSER_ID` (compare privately). | Reviewed commit hash recorded. | Any item unconfirmed. |
| 1 | From Windows, on the network used for the window: `curl.exe -4 -s https://mihugaming.com.tw/cdn-cgi/trace` and `curl.exe -6 -s https://mihugaming.com.tw/cdn-cgi/trace`; record the `ip=` lines (IPv4 `/32`; IPv6 exact `/128`). Use a fixed-line connection, not mobile data (carrier CGNAT shares one IPv4 among many subscribers). | One IPv4 and, if the network has IPv6, one IPv6 address. `warp=off`. | `warp=on`/VPN active, or the address changes between two runs minutes apart. |
| 2a | As `deploy`: `git -C /opt/mihu/app status --short` | Exactly one line: ` M deploy/systemd/mihu-bot.service`. | Any other modified or untracked file. |
| 2b | Keep a record of the local change and fetch the reviewed commit: `git -C /opt/mihu/app diff -- deploy/systemd/mihu-bot.service > ~/mihu-bot-unit.local.patch`; `git -C /opt/mihu/app fetch origin`; `git -C /opt/mihu/app cat-file -e <reviewed-commit>^{commit}` | Patch saved outside the repository; commit exists locally. | Commit not found. |
| 2c | Compare the uncommitted file with the reviewed version: `git -C /opt/mihu/app diff --exit-code <reviewed-commit> -- deploy/systemd/mihu-bot.service` | Exit code 0 and no output: the local change is byte-identical to the reviewed commit (`ExecStart=/usr/bin/node botRunner.js`). | Any output or non-zero exit. Do not stash, discard or overwrite; send the diff for review. |
| 2d | Only after 2c passes: `git -C /opt/mihu/app checkout --merge --detach <reviewed-commit>`. Plain `checkout` refuses because the file is locally modified; `--merge` carries the identical change forward, so nothing is stashed or lost (verified in a scratch clone on 2026-09-28). Then `git -C /opt/mihu/app status --short` and `git -C /opt/mihu/app diff --exit-code <reviewed-commit>` | `HEAD` equals the reviewed commit; status empty; diff exit code 0. | Conflict markers, non-empty status or non-zero diff: stop, keep `~/mihu-bot-unit.local.patch`, report. |
| 3 | `systemctl is-active mihu-web mihu-bot` | `inactive`/`unknown` for both. | Either `active`. |
| 4 | `PREFLIGHT INITIALIZATION` | `status: ACTION_REQUIRED`; `integrity` and `schema` `PASS`; `adminRole: MISSING`; `breakGlassUserPresent: NO`. | `integrity` or `schema` `FAIL`, or `adminRole: PRESENT` (roles already exist). |
| 5 | Backup: `MIHU_RUN --setenv=BACKUP_CONFIRM=YES --setenv=PRODUCTION_WRITES_DISABLED=YES --setenv=BACKUP_STORAGE_VERIFIED=YES --setenv=DATABASE_BACKUP_DIR=/var/backups/mihu /usr/bin/node scripts/backupDatabase.js`, then copy the new backup + manifest off-host. `BACKUP_STORAGE_VERIFIED=YES` is your attestation that the copy exists; `/var/backups/mihu` is on the same disk as the DB. | JSON with the manifest filename; integrity `ok`. Off-host copy checksum matches. | Non-zero exit, or off-host copy not verified. |
| 6 | Role bootstrap: `MIHU_RUN --setenv=RBAC_BOOTSTRAP_CONFIRM=YES --setenv=PRODUCTION_WRITES_DISABLED=YES --setenv=BACKUP_STORAGE_VERIFIED=YES --setenv=RBAC_BOOTSTRAP_BACKUP_MANIFEST=/var/backups/mihu/<manifest> /usr/bin/node scripts/bootstrapProductionRbac.js` | `RBAC_BOOTSTRAP_COMMITTED`, `rolesInserted: 6`. | Any refusal. Do not retry with other flags; investigate first. |
| 7 | `PREFLIGHT INITIALIZATION` | `ACTION_REQUIRED` with every check `PASS` except `breakGlassUserPresent: NO`; `wildcardRoles: PASS`; `payoutDutyCoverage: PASS`. | Any other failing check. |
| 8 | Verify Cloudflare real-IP trust is current: compare `set_real_ip_from` in `/etc/nginx/conf.d/cloudflare-realip.conf` with `https://www.cloudflare.com/ips-v4` and `/ips-v6`; confirm `real_ip_header CF-Connecting-IP`. Record `sudo ufw status verbose` and `sudo nft list ruleset` output in the change record. | Lists identical (22 ranges on 2026-09-28). | Lists differ (update through a separate reviewed Nginx change first). |
| 9 | Nginx: back up `/etc/nginx/sites-available/mihugaming.conf`; write `/etc/nginx/snippets/mihu-init-access.conf` with the step 1 addresses (`allow <ipv4>;`, `allow <ipv6>;`, `deny all;`); write `/etc/nginx/snippets/mihu-init-proxy.conf` from the template's `#| ` lines (`sed -n 's/^#| //p'`); install the template as `sites-available/mihu-rbac-init.conf` with `server_name mihugaming.com.tw www.mihugaming.com.tw;`; enable it and remove only the `sites-enabled/mihugaming.conf` symlink; `sudo nginx -t && sudo systemctl reload nginx`. | `nginx -t` OK. From the allowed Windows browser `https://mihugaming.com.tw/dashboard` returns Nginx 503; from a non-allowed network (phone on mobile data) returns 403. `sudo tail -n 3 /var/log/nginx/access.log` shows your step 1 address as the client, not a Cloudflare range. | `nginx -t` fails; non-allowed network gets anything but 403; access log shows a Cloudflare address or someone else's. |
| 10 | Install units: `sudo install -o root -g root -m 0644 deploy/systemd/mihu-web.service deploy/systemd/mihu-bot.service /etc/systemd/system/ && sudo systemctl daemon-reload`. Do **not** enable or start `mihu-bot`. | `systemctl cat mihu-bot` shows `ExecStart=/usr/bin/node botRunner.js`. | Unit files differ from the reviewed commit. |
| 11 | `echo 'MIHU_RBAC_INITIALIZATION_WINDOW=true' \| sudo tee -a /etc/mihu/mihu-web.env >/dev/null`; `sudo systemctl start mihu-web`; `systemctl is-active mihu-web`; `sudo journalctl -u mihu-web -n 30 --no-pager`; `curl -s http://127.0.0.1:<PORT>/healthz` | `active`; no startup error; `ok`. | Start failure or restart loop (`systemctl stop mihu-web`). |
| 12 | Allowed Windows browser: open `https://mihugaming.com.tw/dashboard`, then `/login`. | `/dashboard`: `RBAC initialization window` 503 text; `/login` renders. | `/dashboard` renders or login page is missing. |
| 13 | Log in with Discord; then open `/management/members`. | Redirect back via `/auth/discord/callback`; member list shows exactly **one** user (you, `member`). DevTools: session cookie `Secure`, `HttpOnly`, `SameSite=Lax`. | OAuth error, more than one user, or cookie not `Secure`. |
| 14 | Edit your own row: role 店長 (`admin`), leave VIP 0, save. | Redirect with success; row shows 店長. A second save returns 403. | 403 on the first save, or any other field/user changes. |
| 15 | `PREFLIGHT INITIALIZATION`, then `PREFLIGHT GO_LIVE` | Both `status: PASS`; `breakGlassStoredRole: ADMIN`; `staffing: [{ studioId: 1, adminOperators: 1, status: STAFFED }]`; `goLive.rbac: RBAC_STAFFED`; `goLive.declared: false`. | Either not `PASS`. |
| 16 | Read-only audit review: `MIHU_RUN /usr/bin/node -e 'const s=require("sqlite3");const d=new s.Database(process.env.DATABASE_PATH,s.OPEN_READONLY);d.all("SELECT action,COUNT(*) n FROM audit_logs GROUP BY action ORDER BY action",(e,a)=>d.all("SELECT role,COUNT(*) n FROM users GROUP BY role",(f,b)=>{console.log(JSON.stringify({audit:e?e.message:a,users:f?f.message:b}));d.close()}))'` | `RBAC_BOOTSTRAP` 1, `discord_identity_register` 1, `ROLE_ASSIGNED` 1, `member_vip_role_update` 1 (2 only if two saves raced); users: `admin` 1. | Any other action or user. |
| 17 | Close the window: `sudo systemctl stop mihu-web`; `sudo sed -i '/^MIHU_RBAC_INITIALIZATION_WINDOW=/d' /etc/mihu/mihu-web.env`; keep the initialization Nginx site until the GO_LIVE_RUNBOOK gates are signed. | Web inactive; flag absent (`sudo grep -c '^MIHU_RBAC_INITIALIZATION_WINDOW=' /etc/mihu/mihu-web.env` prints `0`). | Flag still present. |

IPv4/IPv6 notes: the hostname publishes A and AAAA records at Cloudflare, so a dual-stack Windows client usually connects over IPv6 and Cloudflare sends an IPv6 `CF-Connecting-IP`. Allow both families from step 1, each as a single address (`/32`, `/128`). Windows temporary IPv6 addresses rotate; a rotation is handled by the address-change rule (abort and re-verify), never by allowing the `/64`. If rotation repeatedly interrupts the window, the owner may disable IPv6 temporary addresses on that Windows machine for the window. Do not enable Cloudflare's Pseudo IPv4 header overwrite.

## V. Rollback

Stop both systemd services, maintain ingress/write freeze, preserve logs/manifest, and deploy only the previous reviewed compatible release. Never point an older binary at a DB with a newer schema without explicit compatibility approval. Do not run migration as part of rollback.

## W. Restore

**DANGEROUS — replaces the Production DB file. Requires incident/restore approval.** Stop both services, verify external DB identity and backup checksums, create a fresh pre-restore backup, confirm no `-wal`/`-shm`/journal sidecars or active handles, then run `npm run db:restore` with restore-source and pre-restore manifests and explicit confirmation. Verify integrity/schema/readiness and read-only reconciliation before restart. Off-host backup copy must remain untouched.

## X. Emergency Stop

**DANGEROUS — stops Production services.** Use `systemctl stop mihu-web mihu-bot`; apply provider/firewall ingress restriction if Web must be isolated. Confirm both processes are stopped before any DB migration/restore. Preserve `/var/lib/mihu`, `/var/backups/mihu`, and journal logs. No firewall/systemd command was executed by this runbook authoring task.
