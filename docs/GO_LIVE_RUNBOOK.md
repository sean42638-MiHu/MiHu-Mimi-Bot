# Production Go-Live Runbook

Status: **NO-GO / PREPARATION ONLY**. This checklist is operational guidance; it does not authorize production DB migration, payout, historical repair, credential use, or external smoke tests.

## A. Pre-flight

- [ ] Code commit/release artifact is fixed and reviewed.
- [ ] `npm test`, all repo JS syntax checks, EJS compile, diagnostics, and `git diff --check` pass on the exact artifact.
- [ ] Critical sqlite3/tar dependency gate is resolved by approved remediation; no `npm audit fix --force`.
- [ ] Production backup is complete and restore-tested; metadata is recorded in the change ticket.
- [ ] Secret provider contains the approved `PAYROLL_DATA_ENCRYPTION_KEY`; never copy it to a file or log.
- [ ] Versioned PII key rotation/recovery design is implemented before a future key rotation is attempted.
- [ ] SMTP staging passed and provider credential rotation is confirmed by the owner.
- [ ] Discord staging passed in a Test Guild; Production Guild was not used in staging.
- [ ] Historical finance approval status is recorded; unapproved items remain untouched.
- [ ] Plaintext cache/backup/export inventory and retention actions have owners.

## B. Maintenance / Write Control

- [ ] Record maintenance start time and on-call/approver.
- [ ] Stop all old web, bot, worker, and maintenance-script instances using the production DB.
- [ ] Confirm no payout mutation or other financial transaction is active.
- [ ] Apply infrastructure-level traffic/write restriction. The application has no built-in maintenance switch.
- [ ] Preserve the timestamped pre-migration backup and verified manifest under approved external storage/retention controls.

## C. Migration

- [ ] Run the read-only PII status scan and save counts only: `node scripts/payrollEncryptionStatus.js`.
- [ ] Review total/plaintext/encrypted/null/invalid counts; never dump values.
- [ ] Set the verified Production identity/storage confirmations and explicit absolute persistent `DATABASE_PATH` in the Hosting secret/config source; never put secrets in `.env` committed to the repository.
- [ ] Run `npm run db:readiness`; PASS is configuration/schema readiness only, not deployment or RBAC verification.
- [ ] Stop writers, create a verified pre-migration backup with `npm run db:backup`, then run `npm run db:migrate` with its explicit confirmation and manifest.
- [ ] Confirm migration failures exit non-zero; Web/Bot startup must only validate schema and must not migrate.
- [ ] Run `npm run db:preflight` only after externally verifying the Production instance and setting `PRODUCTION_PREFLIGHT_CONFIRM=YES`.
- [ ] Run `node scripts/payrollEncryptionStatus.js --require-encrypted`; require zero plaintext and invalid ciphertext values.
- [ ] Verify schema/index/defaults; no production payout/test row may be inserted.

## D. Financial Sanity

- [ ] Wallet mirror read-only report: all expected balances match.
- [ ] Reconciliation V2 read-only report: compare to the approved baseline; investigate only newly introduced differences.
- [ ] Order payment/refund/commission reconciliation: no new unexplained differences.
- [ ] Payout reconciliation: production currently has zero payout rows; do not seed one for testing.
- [ ] Commission settings and active-period partial index are present.
- [ ] Confirm historical wallet/order differences and Order 61 remain untouched unless separately approved.

## E. Security / Application

- [ ] Secret presence verified without printing the value.
- [ ] Missing/wrong key fail-closed behavior confirmed in staging.
- [ ] CSRF, permission allow/deny, Studio isolation, staff/payroll masking, audit redaction, and request-time XLSX authorization pass.
- [ ] Confirm no sensitive values in logs, URL query strings, audit data, or static `public/` files.
- [ ] Profile writes encrypt; payout snapshots encrypt; staff/payroll readers decrypt only after permission checks.

## F. External Services

- [ ] SMTP staging checklist signed; production controlled smoke requires separate approval.
- [ ] Discord staging checklist signed; command registration target is explicitly the Production Guild only at approved release time.
- [ ] No bulk email or bulk command/role mutation during smoke checks.
- [ ] Production credential rotation/old-secret revocation confirmed without exposing values.

## G. Go / No-Go

**GO only if every required gate below is signed:**

- [ ] Dependency critical resolved or formally accepted with evidence by security owner.
- [ ] Production PII migration and post-scan pass.
- [ ] Secret recovery and backup restore have passed.
- [ ] External staging and rotation checklists pass.
- [ ] No new unexplained financial reconciliation difference.
- [ ] Manual financial approvals are recorded; no inferred repair is pending.

Any critical gate failure, invalid ciphertext, nonzero plaintext post-scan, missing key, new unexplained finance delta, or unapproved external target is **NO-GO**.

## H. Rollback

- [ ] Keep writes restricted; record incident/change ID and time.
- [ ] Before encryption transaction commit: application startup fails and migration rolls back.
- [ ] If DB encryption committed but cache sync/startup failed: retry with the same staged key; do not start an older plaintext-only build.
- [ ] If restore is necessary, restore the approved consistent backup under maintenance and verify which key/version can decrypt it.
- [ ] Never discard the only key capable of decrypting an encrypted backup/database.
- [ ] Re-run read-only reconciliation and PII count scan after rollback/restore.
- [ ] Record approver, operator, restore source, schema/app versions, and final verification.
