# Production Safety Foundation

Status: Hosting-neutral code contract only. No Production runtime, database, backup, restore, or migration was executed.

## Runtime and Database Contract

- Web and Bot startup perform a read-only schema/readiness check. They do not create tables, seed JSON data, migrate, encrypt data, or sync caches.
- Production requires `NODE_ENV=production`, an absolute `DATABASE_PATH`, an existing SQLite database file, and externally confirmed `PRODUCTION_IDENTITY_VERIFIED=YES` plus `PRODUCTION_STORAGE_VERIFIED=YES` for safety commands.
- Production refuses a missing/relative path, the repository-local `database.sqlite`, the isolated Development DB, or a missing file. The SQLite adapter does not create a Production DB file.
- Development path selection remains pinned to `data/development.sqlite`; Test requires `TEST_DATABASE_PATH` under the OS temporary directory.
- `npm run db:readiness` inspects configuration/file state only. `PASS` does not prove Production deployment identity or RBAC state.
- `npm run db:preflight` requires `PRODUCTION_PREFLIGHT_CONFIRM=YES`, externally confirmed identity/storage, and opens SQLite with `OPEN_READONLY`. It does not import `database.js`. It reports that Production deployment/RBAC remain unverified until separately evidenced.

## Explicit Migration Contract

1. Stop all Web, Bot, worker, and maintenance writers; set `PRODUCTION_WRITES_DISABLED=YES` only after confirming they are stopped.
2. Create a timestamped backup to externally verified storage and preserve its manifest.
3. Set `MIGRATION_BACKUP_MANIFEST` to that manifest and `MIGRATION_CONFIRM=YES` for one command.
4. Run `npm run db:migrate`. It verifies backup identity/checksum/integrity, then invokes the existing migration initializer and checks the required schema/migration markers. The wallet-composition migration adds `wallet_transactions.bonus_amount` (`NOT NULL DEFAULT 0`). Existing ledger rows remain zero in this column and are treated as principal-only; the migration does not infer, split, or rewrite historical payment/refund composition.
5. Any validation, migration, or readiness failure exits non-zero; do not start Web/Bot. The command never continues after a rejected migration.

Production migration has not been executed by this foundation task.

## Backup Contract

Command: `npm run db:backup`.

Required: explicit `BACKUP_CONFIRM=YES`, absolute `DATABASE_BACKUP_DIR` separate from the DB directory, `BACKUP_STORAGE_VERIFIED=YES` for Production, and the normal Production identity/storage confirmations. The source opens `OPEN_READONLY`; SQLite's online backup API creates `mihu-database-<UTC timestamp>.sqlite`. A sidecar manifest records the UTC timestamp, redacted source-identity hash, backup SHA-256, filename, and `integrity: ok`. Source and output integrity checks must pass. The command never removes old backups.

## Restore Contract

Command: `npm run db:restore`. This is a write operation and must only be used as a separately approved operator action, never as a readiness/preflight step.

- Stop every runtime/writer and confirm `PRODUCTION_WRITES_DISABLED=YES`; restore refuses SQLite WAL/SHM/journal sidecars.
- Provide a checksum/integrity-verified restore-source manifest and a separate, fresh pre-restore backup manifest, both bound to the same configured database identity.
- Require `RESTORE_CONFIRM=YES` and the external Production identity/storage confirmations.
- Restore first to a timestamped staging file, verify SHA-256, SQLite integrity, and application schema readiness, then swap files. The displaced database is retained as a timestamped `.pre-restore-...sqlite` quarantine. If final validation fails, the script attempts to restore the quarantine file and exits non-zero.
- After restore, run readiness and read-only Production preflight; do not automatically run migrations.

## Retention and Hosting Requirements

Retain at least 30 daily and 12 monthly verified backups, subject to longer legal/financial retention and legal hold. Deletion is a separately approved storage operation; the backup command never prunes. Store backups in access-controlled storage separate from the database volume and periodically test restore on a non-Production copy.

Phase 12.9-B must select Hosting and prove persistent-volume semantics, Production env injection, Node runtime/start command, custom domain/HTTPS, separately managed Discord Bot runtime, DB path, backup storage, restore access, and operator access. This document creates no platform-specific configuration and assumes no volume path.
