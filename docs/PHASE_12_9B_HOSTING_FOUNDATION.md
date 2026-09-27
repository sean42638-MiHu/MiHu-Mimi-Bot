# Phase 12.9-B — Hosting / Runtime Foundation

Status: **VPS/VM ARCHITECTURE SELECTED — INFRASTRUCTURE NOT PROVISIONED**. No Production deployment, Production DB connection, DNS/HTTPS change, VPS account, OAuth run, Discord call, or SMTP call was performed. Local `database.sqlite` is not identified as Production.

## Runtime Inventory

| Area | Repository evidence | Production implication |
|---|---|---|
| Web | `npm start` → `node index.js` → Express app; EJS views and `express.static(public/)` | One long-running HTTP process; platform supplies `PORT`; no separate frontend hosting is indicated. |
| Web binding | Production requires `WEB_LISTEN_HOST=127.0.0.1`; Nginx proxies to the loopback listener. | Web port must not be exposed publicly. |
| Node | Production contract is Node >=24.0.0 <25; current development runtime is Node v24.21.0. Installed sqlite3 6.0.1 declares Node >=20.17.0. | Verify the selected Ubuntu LTS x64 Node 24 package/runtime before deployment. |
| SQLite / JSON mirrors | sqlite3 6.0.1; `DATABASE_PATH` selects the DB file; `PRODUCTION_DATA_DIR` selects JSON mirrors. Both must be absolute, existing, persistent, and outside the repo. | Provision state separately from code; no ephemeral storage or runtime mkdir is allowed. |
| Startup | Web/Bot run read-only schema readiness. Migrations require `npm run db:migrate`, explicit confirmation, writer freeze, and verified backup manifest. | No deployment can bootstrap an empty DB by starting the app. |
| Readiness | `/healthz` is minimal unauthenticated liveness. `db:readiness` checks configuration/schema. `db:preflight` performs externally confirmed `OPEN_READONLY` checks. | Liveness, readiness, Production identity, and RBAC verification are distinct states. |
| Web session | `express-session` default MemoryStore; secure cookie in Production; `SESSION_SECRET` required. | One Web replica only until an external shared session store is designed and tested. Sessions are lost on restart. |
| OAuth | Discord Passport, `state: true`, identify/guilds scopes. Production requires explicit HTTPS `PUBLIC_BASE_URL` and matching callback `/auth/discord/callback`. | Register the exact callback with Discord manually after domain selection. No domain is inferred from source defaults. |
| Bot | `botRunner.js` is an independent long-running Discord Gateway process, requires `DISCORD_ENABLED=true` and Bot token. `index.js` does not start Bot. | Needs outbound WebSocket connectivity, restart policy, separate logs/secrets, and DB access. |
| Command registration | Separate service/CLI. DEV and Production registration have different gates; Production requires explicit `DISCORD_COMMAND_REGISTRATION_ENABLED=true`. | Never run command registration during deployment smoke unless separately approved. |
| SQLite concurrency | Web and Bot each have their own SQLite connection. `withTransactionGate` serializes only within one process. Busy timeout is configurable and defaults to 5000 ms. Cross-process transaction tests pass on local OS-temp storage. | SQLite locking is local-filesystem dependent; the gate is not a cross-process lock. |
| Journal/foreign keys | Application does not set `journal_mode`; SQLite's actual persisted mode must be read from the target DB. Application connections do not explicitly enable `foreign_keys`. | Do not assume DELETE/WAL or FK enforcement. Preflight reports journal mode; confirm and test the chosen DB state before go-live. |
| Shutdown | Web and Bot now handle SIGTERM/SIGINT and close server/client and DB connections. | Hosting must allow graceful termination and provide sufficient shutdown grace time. |
| External services | SMTP is disabled unless enabled with complete config. OAuth/Discord secrets are configuration only at startup; Production calls were not made. | Keep Web OAuth, Bot Gateway, and SMTP roles/secrets scoped to their service. |

## Topology Assessment

### Option A — Web and Bot in one Node process

Not recommended for this repository. `index.js` and `botRunner.js` are deliberately separate entrypoints. A combined process would couple Gateway reconnects and Bot crashes to Web deployment/restart, complicate signal handling, and retain the same single-writer SQLite limit without removing operational coupling. It would share one in-process DB queue, but that is not needed for current separation.

### Option B — Separate Web and Bot processes

Recommended, **co-located on one host with one local persistent volume**. This matches the repository entrypoints and gives independent restart/crash/deploy lifecycle. Both processes can use SQLite's same-host file locking; `busyTimeout` reduces brief lock failures but does not create multi-writer concurrency. Keep one Web replica because sessions are in MemoryStore; keep one Bot process per configured production Bot/Guild set.

**Critical SQLite condition:** the two processes must see the same DB file on the same host/local filesystem with working advisory locks. A volume attached to two unrelated hosts, NFS/network share, or platform-specific cross-service volume is not presumed safe. If the selected Hosting cannot provide this topology, do not split the processes across hosts while retaining SQLite; choose one host/supervisor or plan a separately approved migration to a server DB.

Selected architecture: **Ubuntu LTS x64 VPS/VM, one host, two supervised Node processes, one local persistent block volume**. Web handles HTTPS ingress; Bot maintains outbound Discord Gateway connection. Both use the same absolute `DATABASE_PATH`. The VPS provider/instance and actual Production topology remain unprovisioned/unverified.

## SQLite Storage Contract

- Persistent Volume: **REQUIRED**. `NODE_ENV=production` and `APP_ENV=production`; both Web and Bot receive the same absolute `DATABASE_PATH` pointing to an existing SQLite file.
- Repository-local `database.sqlite`, `data/development.sqlite`, relative paths, missing files, and ephemeral filesystems are refused by Production selection/readiness guards.
- The containing filesystem must support SQLite locks and atomic same-filesystem rename. Keep the main DB, rollback journal or WAL/SHM sidecars together on the same persistent volume.
- The repository does not force WAL. Existing DB journal mode is stateful; inspect it read-only during preflight. WAL requires durable co-located `-wal`/`-shm` files and all connections to use the same local filesystem. No network-filesystem compatibility is claimed.
- Configured SQLite busy timeout is `SQLITE_BUSY_TIMEOUT_MS` (100–30000 ms; sample 5000). It helps wait out short locks; it does not permit multiple simultaneous writers.
- Backup uses sqlite3's online backup API from a readonly source connection, then SHA-256 and `PRAGMA integrity_check`. Restore stages a copy, checks integrity/schema, swaps only after explicit operator confirmation, and retains a quarantine copy.
- Production backup directory must be absolute, separate from the DB directory, and externally verified. The script does not prove that a mount is off-host; off-host replication is an operator/storage-provider requirement.

## Production ENV Contract

Values are never recorded here. `SECRET` entries must come from the Hosting secret manager. `MIHU_RUNTIME_ROLE` is `web` or `bot` per process.

| ENV | Required | Secret | Purpose |
|---|---|---|---|
| `NODE_ENV` | Yes: `production` | No | Runtime/security mode. |
| `APP_ENV` | Yes: `production` | No | Application/database scope. |
| `MIHU_RUNTIME_ROLE` | Yes | No | Separate Web and Bot readiness contracts. |
| `PORT` | Web: Yes | No | Hosting-assigned HTTP port. |
| `DATABASE_PATH` | Yes, both | No (path withheld in reports) | Same existing persistent SQLite file. |
| `PRODUCTION_DATA_DIR` | Yes, both | No (path withheld in reports) | Persistent JSON mirror directory outside repository. |
| `SQLITE_BUSY_TIMEOUT_MS` | Yes, both | No | Bounded SQLite lock wait. |
| `TRUST_PROXY_HOPS` | Web: Yes | No | Exact trusted TLS proxy hop count; set only to match actual ingress topology. |
| `PUBLIC_BASE_URL` | Yes | No | Public HTTPS origin used by Discord links and callback validation. |
| `SESSION_SECRET` | Web: Yes | Yes | Session signing; Production startup refuses missing/short values. |
| `PAYROLL_DATA_ENCRYPTION_KEY` | Yes, both | Yes | PII encryption/decryption. |
| `PLATFORM_SUPERUSER_ID` | Yes, both | Yes/sensitive identifier | Server-side break-glass principal; never derive from client input. |
| `DISCORD_CLIENT_ID` | Web: Yes; Bot command tooling: Yes | No | OAuth application/command application identity. |
| `DISCORD_CLIENT_SECRET` | Web: Yes | Yes | OAuth secret. |
| `DISCORD_CALLBACK_URL` | Web: Yes | No | Exact HTTPS `PUBLIC_BASE_URL/auth/discord/callback`. |
| `DISCORD_BOT_TOKEN` or `DISCORD_TOKEN` | Bot: Yes; Web only if using command deployment route | Yes | Discord Gateway/registration credential. |
| `DISCORD_ENABLED` | Bot: `true` | No | Explicit Bot runtime enablement. |
| `GUILD_MAIN_ID` | Bot/registration: Yes | No | Production main Guild. |
| `GUILD_STAFF_ID` | Bot/registration: Yes | No | Production staff Guild. |
| `GUILD_REVIEW_ID` | Feature-dependent | No | Review Guild configuration. |
| `GUILD_DEV_ID` | DEV deployment/testing only | No | Never substitute for Production Guild. |
| `DISCORD_COMMAND_REGISTRATION_ENABLED` | Optional; default off | No | Explicitly gates Production command registration. |
| `DISCORD_COMMAND_CLEAR_ENABLED` | Optional; default off | No | Destructive command-clear gate; keep off in normal deployment. |
| `SMTP_ENABLED` | Optional; default off | No | Email service toggle. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` | If SMTP enabled | `SMTP_USER/PASS` sensitive | SMTP transport configuration. |
| `WEBSITE_URL`, `DASHBOARD_URL` | Legacy optional | No | Dev fallback only; Production command links use `PUBLIC_BASE_URL`. |
| `DEPLOYMENT_PLATFORM` | Optional | No | Display/status label only; not proof of hosting identity. |
| `PRODUCTION_IDENTITY_VERIFIED`, `PRODUCTION_STORAGE_VERIFIED` | Safety commands: explicit `YES` | No | Operator confirmation after external identity/volume verification. |
| `DATABASE_BACKUP_DIR`, `BACKUP_STORAGE_VERIFIED`, `BACKUP_CONFIRM` | Backup command | No | Explicit backup location, external storage assertion, one-run confirmation. |
| `PRODUCTION_WRITES_DISABLED`, `MIGRATION_BACKUP_MANIFEST`, `MIGRATION_CONFIRM` | Production migration | No | Writer freeze, verified backup manifest, one-run confirmation. |
| `RESTORE_BACKUP_MANIFEST`, `PRE_RESTORE_BACKUP_MANIFEST`, `RESTORE_CONFIRM` | Production restore | No | Restore-source and fresh pre-restore backup manifests, one-run confirmation. |
| `PRODUCTION_PREFLIGHT_CONFIRM` | Production preflight | No | One-run confirmation after external Production identity verification. |
| `TEST_DATABASE_PATH`, `DEVELOPMENT_DATA_DIR`, `DEV_*`, `ALLOW_EXTERNAL_*_IN_TEST` | Dev/Test only | Mixed | Never reuse as Production configuration. |

`PUBLIC_BASE_URL` is now the canonical public URL candidate; no Production domain is selected. OAuth callback remains explicitly configured and is not guessed. `BUSINESS_TIMEZONE` is stored in the DB's `system_settings`, not read as a Production ENV by current runtime code.

## Domain / HTTPS / Reverse Proxy

- Frontend and backend are the same Express/EJS service; static files are served from `public/` by Express.
- Repository contains no confirmed Production domain or frontend/backend split.
- TLS must terminate at the selected Hosting ingress/reverse proxy or be provided by a separately configured TLS endpoint. App must trust only the exact configured proxy hop count via `TRUST_PROXY_HOPS`.
- Secure session cookies require Production mode and correct forwarded HTTPS handling. Proxy must preserve the public Host and forward protocol consistently; otherwise OAuth/CSRF/session behavior can fail.
- Same-origin CSRF compares Origin/Referer host with request Host. No CORS policy or reverse-proxy behavior has been certified on a real provider.
- OAuth uses Passport Discord state protection. Configure Discord Developer Portal callback manually to the exact `DISCORD_CALLBACK_URL`; no OAuth was run and no portal was changed.
- `commands/website.js` previously had a hardcoded dashboard-domain fallback; it now uses the shared public URL helper. `register` / `register-for` use the same `PUBLIC_BASE_URL` contract.

## Hosting Requirements and Candidate Assessment

### MUST HAVE

- Long-running Node 24-compatible HTTP and Gateway processes; current package has no `engines` declaration, sqlite3 6.0.1 requires Node >=20.17.0.
- Local persistent block storage and working same-host filesystem locks; both processes mount the same existing DB path.
- Production secret/env injection, custom domain/HTTPS ingress, trusted proxy configuration, restart policy, graceful SIGTERM, logs, and liveness HTTP check (`/healthz`).
- Operator shell/job to run readonly readiness/preflight, explicit backup/migration/restore contracts, and ability to stop all writers.

### SHOULD HAVE

- Independent process supervision/restart for Web and Bot on the same host; resource/health monitoring; tested restore to a non-Production copy; separately access-controlled off-host backup copy and retention lifecycle.
- A single Web replica unless MemoryStore is replaced with a shared session store. Avoid autoscaling Bot replicas without an explicit Discord Gateway/sharding plan.

### OPTIONAL

- Provider-managed TLS, monitoring/alerting integration, secret-manager integration, remote object storage replication, and automated backup scheduling (with retention review).

### NOT REQUIRED

- Separate static frontend host, serverless request functions, or horizontal Web scaling for the initial SQLite topology.

| Candidate | Fit for this repository | Must verify manually |
|---|---|---|
| Single VPS/VM | Best initial fit for two Node processes sharing one local persistent volume; maximum operator responsibility. | Filesystem durability/locking, backups, OS patching, TLS proxy, monitoring, restore access. |
| Render / Railway / Fly.io | Possible only if current product supports a durable volume and the Web/Bot processes can safely access the same local volume/host. | Volume attach/share semantics, cross-process/host behavior, outbound Discord WebSocket, shell/jobs, restart/signal grace, backup extraction, custom domain/TLS, current plan/pricing. |
| Vercel / Cloudflare Workers | Not suitable for the current native sqlite3 + persistent local file + long-lived Gateway architecture without substantial redesign. | A different server DB and Bot runtime would be required; platform-specific current features must still be verified. |
| Other managed platforms | Evaluate against the MUST HAVE list; no provider is selected by this repository. | Persistent local SQLite semantics, two runtime processes, WebSocket egress, shell/migrations, domain/TLS, and backups. |

**Recommendation:** Option B: separate Web and Bot processes co-located on one host/local persistent volume. If the chosen Hosting requires each process to run on a different host or only offers a shared network filesystem, SQLite is not approved for that topology; either co-locate or separately approve a server-database migration.

## Deployment and Disaster Recovery Sequence

1. Select Hosting and manually verify product/version capabilities; record provider, runtime type, Node/OS/architecture, ingress, volume and backup storage.
2. Provision one local persistent volume and its mount identity; choose an absolute `DATABASE_PATH` only after the provider is selected.
3. Configure separate Web/Bot Production env scopes with shared DB identity and the role-specific ENV contract.
4. Establish/restore an existing DB file through an approved process; never let Web startup create it.
5. Verify independent backup storage and retention; create/verify a backup before migration.
6. Run `npm run db:readiness` in the intended Web environment; it is config/schema readiness only.
7. Stop writers; run `npm run db:backup`; separately confirm off-host copy if required.
8. Run `npm run db:migrate` only if migration is approved and backup manifest matches the DB identity.
9. Start Web and Bot separately; Web listens on `PORT`, Bot maintains outbound Gateway. Confirm graceful restart works.
10. Probe `/healthz`, validate externally configured HTTPS/domain/reverse-proxy, then validate OAuth callback only with a controlled approved check.
11. Run `npm run db:preflight` from the verified Production runtime with `PRODUCTION_PREFLIGHT_CONFIRM=YES`.
12. Only a successful Production RBAC preflight can mark Production RBAC verified; readiness or an HTTP 200 is insufficient.

### Disaster Recovery Contract

- Primary backup: `DATABASE_BACKUP_DIR` on storage separate from the DB directory; provider access/permission verified externally.
- Off-host copy: **REQUIRED operational control**; this repository's backup command writes a local configured directory and does not upload to cloud object storage.
- Integrity: source and backup `PRAGMA integrity_check`, SHA-256 backup checksum, source file fingerprint, timestamped sidecar manifest.
- Restore: stop all writers, verify source/pre-restore manifests, stage copy, checksum/integrity/schema verify, rename with pre-restore quarantine, verify again, and keep services stopped on failure.
- Retention: at least 30 daily plus 12 monthly copies, unless legal/financial policy requires longer. No automatic pruning is performed by the script.
- Restore verification: periodically restore to a non-Production copy and verify app schema/readiness and business read-only checks. Never use Production as the test target.

## Current Blockers / Owner Decisions

- Hosting/provider, Production OS/Node architecture, custom domain, TLS ingress and proxy hop count are not selected.
- No Production persistent volume/path or externally verifiable DB identity exists in repository.
- Web and Bot deployment/service ownership and shared local-volume access must be approved.
- Production session/OAuth/encryption/break-glass secrets, Guild IDs and callback are not provisioned/verified here.
- Session storage remains process-memory; plan one Web replica or approve a shared session store.
- SQLite journal mode and provider lock guarantees remain unknown until the real volume is selected and read-only preflighted.
- Backup script does not implement off-host transfer or automated retention; provider/ops must supply those controls.
- No deployment, Production DB connection/write/migration/backup/restore, OAuth, Discord, SMTP, DNS, or Hosting account action was performed.
