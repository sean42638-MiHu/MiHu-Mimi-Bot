# Production PII Migration Runbook

Status: **MANUAL DEPLOYMENT REQUIRED — NOT EXECUTED**. Production database and cache are currently unencrypted. Do not run this procedure until the deployment owner approves a maintenance window, stages the secret, and confirms backups.

## Preconditions

- A production secret provider has provisioned a 32-byte `PAYROLL_DATA_ENCRYPTION_KEY`; the application accepts base64 or 64-character hex. Do not put the value in a command, ticket, log, repository, or database.
- A sanitized pre-production copy has passed startup, profile, payout, staff/payroll, XLSX, restart, and restore validation.
- Production DB backup is complete and restore-tested; record backup time, DB/schema version, application commit, and migration version.
- Inventory and secure handling for prior plaintext `data/users.json`, DB backups, exports, and snapshots is approved.
- All web instances, bot processes, workers, and maintenance scripts that can write profile/bank fields are stopped. This release does not provide an application maintenance-mode switch; enforce write/traffic restrictions at the deployment/load-balancer layer.

## Procedure

1. **Provision key:** inject the secret through the deployment secret provider as `PAYROLL_DATA_ENCRYPTION_KEY`. Codex/application must not generate or display a production key.
2. **Verify fail-closed behavior in staging:** start without the key against synthetic plaintext data and confirm startup exits before HTTP/Discord listeners start. Restore the staged key through the secret provider, not shell history.
3. **Backup:** take a consistent DB backup and secure a copy of the current JSON cache/backups under the organization's retention controls. Record metadata only; never paste PII into this runbook.
4. **Restrict writes:** stop all old application versions and prevent profile/payroll mutations while migration is running. Confirm no payout operation is active.
5. **Pre-scan:** run `node scripts/payrollEncryptionStatus.js` in read-only mode with the production DB path and secret provider environment. Save only the count report in the approved change record. Do not print/export row values.
6. **Run migration:** deploy the reviewed version and start the application once in the restricted maintenance environment. `initializeDatabase()` applies payout/schema and commission migrations, then transactionally encrypts non-empty `users` and `payouts` fields, records the migration marker, rewrites the ignored users JSON cache with ciphertext, and resolves `db.startupReady`. Web and bot listeners wait for readiness. Any missing/wrong key, DDL/DML/cache error leaves the service unstarted.
7. **Post-scan:** run `node scripts/payrollEncryptionStatus.js --require-encrypted`. Require `plaintext_values=0`, `invalid_ciphertext_values=0`, and expected encrypted counts. The scan uses SQLite `OPEN_READONLY` and emits counts only.
8. **Application checks:** verify profile decrypt for the owner, masked employee payout history, sensitive permission allow/deny, manager Studio scope, request-time XLSX, payout/reconciliation reads, and audit redaction using approved staging accounts. Do not create a production test payout.
9. **Restart and release:** restart every web/bot instance with the same secret-provider key. Confirm readiness and health checks before removing infrastructure-level write restrictions.

## Failure / Rollback

- Before DB transaction commit: migration rolls back all field updates; startup fails closed. Preserve logs only if they contain no secrets/PII.
- If DB commit succeeds but JSON cache rewrite fails: application startup still fails. Keep traffic restricted and retry startup with the same key; do not downgrade to plaintext-reading code.
- If post-scan/decryption fails: keep traffic restricted, retain the original secured backup, diagnose key/config/ciphertext counts, and use the approved restore plan. Never repair individual rows by hand.
- After ciphertext is written, an older application version cannot safely read it. Rollback requires a reviewed compatible code version and the same key, or a controlled backup restore under maintenance. Do not restore a plaintext backup and serve it without re-running the migration.

## Sign-Off

| Gate | Owner | Evidence / record | Status |
|---|---|---|---|
| Secret staged, not disclosed | Deployment/security | Secret version identifier only | REQUIRED |
| Backup and restore verified | DBA | Backup metadata / restore test | REQUIRED |
| Write restrictions active | Operations | Start/end timestamps | REQUIRED |
| Pre-scan counts saved | Security | Count-only report | REQUIRED |
| Startup migration succeeds | Application owner | Startup/readiness log with no secrets | REQUIRED |
| Post-scan plaintext/invalid count = 0 | Security/DBA | Count-only report | REQUIRED |
| Profile/payroll/export smoke tests pass | Product/security | Staging test record | REQUIRED |
| Write restrictions removed | Operations | Release approval | REQUIRED |
