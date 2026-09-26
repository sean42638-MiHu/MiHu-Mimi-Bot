# Sensitive Payroll Data Security

Status: **AES-256-GCM AT-REST ENCRYPTION IMPLEMENTED / PRODUCTION ROLLOUT BLOCKED**. The current production database/cache remains plaintext until a secret-provider key is staged and the startup migration runs. The migration is tested only on temporary databases. No production row was read or modified for this audit.

## Sensitive Payroll Data Map

| Field | Source of truth | Table/column | Readers | Writers | Display/export | Logged/audit | At-rest protection | Risk |
|---|---|---|---|---|---|---|---|---|
| Legal name / account holder | Member profile | `users.real_name`; copied to `payouts.account_name_snapshot` at request time | Own profile; `payout.view_sensitive` staff/payroll; authorized pending XLSX | Authenticated member profile; payout request snapshot | Own profile; sensitive staff/payroll; permission-protected request-time XLSX | Profile audit stores presence only; payout audits omit name | AES-256-GCM envelope in existing TEXT columns | High if key/host/backups are compromised |
| Bank name | Member profile | `users.bank_name`; copied to `payouts.bank_name_snapshot` | Own profile; authorized staff/payroll; payout service; request-time export | Authenticated member profile; encrypted payout request snapshot | Own profile; sensitive staff/payroll and export | Omitted from audit values | AES-256-GCM envelope | High if key/host/backups are compromised |
| Bank/institution code | Member profile | `users.bank_code`; copied to `payouts.bank_code_snapshot` | Own profile; authorized staff/payroll; payout service; export | Authenticated member profile; encrypted payout request snapshot | Own profile; sensitive staff/payroll and export | Omitted from audit values | AES-256-GCM envelope | Medium-high; key management and backups remain operational concerns |
| Branch | Member profile | `users.bank_branch`; copied to `payouts.bank_branch_snapshot` | Own profile; authorized staff/payroll; payout service; export | Authenticated member profile; encrypted payout request snapshot | Own profile; sensitive staff/payroll and export | Omitted from audit values | AES-256-GCM envelope | Medium-high; key management and backups remain operational concerns |
| Bank account number | Member profile | `users.bank_account`; copied to `payouts.bank_account_snapshot` | Own profile; payout service; `payout.view_sensitive`; `payout.export` | Authenticated member profile; encrypted payout request snapshot | Own profile masked in payout history; raw only in permission-gated staff/payroll and XLSX | Never intentionally logged/audited; reject free text is scrubbed | AES-256-GCM envelope; random IV, authentication tag | High if key/host/backups are compromised; rotation and recovery runbook missing |
| National ID | Not implemented | No field or column found | None | None | None | None | Not stored by this application | No application-held value; do not add without a separate decision |

### Other Copies And Controls

- `data/users.json` is a runtime cache that can contain all `users` columns. It is ignored by Git and is not tracked; startup migration rewrites it with the encrypted DB values and the application fails startup if that rewrite fails.
- The manager XLSX endpoint creates the workbook per authenticated request, requires `payout.export` and `payout.view_sensitive`, is Studio-scoped, and writes an export audit. It does not publish files under `public/`.
- Ordinary payout lists redact raw snapshot fields. Staff list SQL now selects bank fields only for `payout.view_sensitive`; UI `data-staff` payload follows the same gate.
- `writeAuditLog` redacts sensitive-key paths; payout audit payloads contain IDs, amounts, status, actor/time, and no bank/name values. Rejection reasons redact ID-like and long numeric sequences.
- No bank/name/ID value is intentionally emitted in application logs or URL query strings.
- No bank fields are used in SQL equality lookup or uniqueness constraints. The active payout uniqueness constraint uses only `user_id`, `studio_id`, `withdrawal_period`, and `status`.

## At-Rest Decision

Bank account and account-holder snapshots are encrypted at rest in the existing TEXT columns with AES-256-GCM using an environment/secret-provider key; no key is hard-coded, stored in SQLite, or committed. Because the inspected bank fields have no equality-lookup use, no deterministic fingerprint is needed.

`PAYROLL_DATA_ENCRYPTION_KEY` must be a valid 32-byte key (base64 or 64-character hex) from an environment/secret provider. Startup fails closed when it is absent/invalid; wrong-key ciphertext also blocks startup. Decrypting a plaintext row outside migration throws. Existing values migrate transactionally; the ignored JSON cache is rewritten before startup readiness resolves. If migration or cache replacement fails, web and bot runtimes do not start.

## Remaining Risks / Operational Requirements

- Rotation requires an explicit key-version migration and a managed secret-provider procedure; no automatic rotation is implied.
- Database backups, host access, swap/core dumps, and downloaded XLSX files remain separate operational controls.
- A temporary test key is generated per test run only; it is never stored in repo or database.
- Production migration has not run. Stage a secret-provider key, test decryption/backup/restore on a sanitized copy, inspect/remove prior plaintext cache/backups, and establish key recovery/rotation before rollout.
