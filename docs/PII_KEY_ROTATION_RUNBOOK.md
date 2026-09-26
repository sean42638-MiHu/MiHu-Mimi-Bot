# PII Key Rotation Runbook

Status: **DESIGN ONLY — ROTATION NOT IMPLEMENTED OR EXECUTED**. Do not replace `PAYROLL_DATA_ENCRYPTION_KEY` in production until multi-key support is implemented and tested.

## Current Format / Limitation

- Current ciphertext envelope: `enc:v1:<base64 IV>:<base64 GCM tag>:<base64 ciphertext>`.
- `v1` identifies the envelope/algorithm format; it does **not** identify a distinct key ID.
- Current code uses one `PAYROLL_DATA_ENCRYPTION_KEY`. A simple environment-key swap makes existing values undecryptable; startup correctly fails closed.
- Production key status: **NOT PROVISIONED / NOT VERIFIED**. `k1` is only a proposed operational label for the first production key, not an existing secret.
- Current key version: there is no key ID in the current cipher envelope. Record the secret-provider version identifier separately when the first key is manually provisioned.
- Rotation is therefore **not currently safe or supported**.

## Required Implementation Before First Rotation

1. Introduce a versioned key identifier, e.g. `enc:v2:<kid>:<iv>:<tag>:<ciphertext>`, without changing payout uniqueness/search columns.
2. Resolve encryption keys only from a secret provider/environment key ring (active key ID plus explicitly retained prior key IDs). Never store key material in SQLite, files, logs, or repository.
3. Readers must select the key by `kid`, support old and new keys during a bounded transition, and fail closed for unknown/missing key IDs.
4. Writers encrypt new values with the active key ID only.
5. Add an idempotent, transaction-safe re-encryption migration that decrypts with the old key and encrypts with the new key. Keep row IDs/status/audit relationships unchanged.
6. Test mixed-key reads, wrong/missing key, tampered ciphertext, partial failure rollback, restart/resume, profile writes, payout snapshots, manager lists, exports, and cache rewrite on isolated databases.

## Rotation Procedure (Future; Not Executable Yet)

1. Approve a change window; stop all app/bot writers and payout mutations.
2. Create and restore-test an encrypted backup; record DB/schema/app/migration versions.
3. Provision the next key (`k2`) in the secret provider. Keep `k1` available but never display either value.
4. Deploy dual-key reader/new-key writer code to all instances, then verify `k1` reads and `k2` writes in staging.
5. Run a read-only key/version census that emits counts only; confirm expected `k1`/`k2` totals.
6. Run re-encryption under transaction/maintenance controls; verify no unknown key IDs, invalid ciphertext, or plaintext values.
7. Restart every app/bot process with both authorized key references available; run profile/payroll/payout/export and reconciliation checks.
8. Retain `k1` in the secret provider until backup retention and restore obligations expire and all `k1` ciphertext is verified absent.
9. Remove `k1` access only after owner/security sign-off and a tested recovery procedure.

## Rollback / Failure Recovery

- Before transaction commit: rollback all row changes and continue reading with `k1`.
- After commit but before completion: dual-key readers must remain deployed; do not roll back to single-key code.
- If `k2` is unavailable or invalid: stop writers, restore access to the previous key version, verify the key ID census, and recover from the secured backup if required.
- Never delete/rotate away an old key while any retained backup or database value may still require it.
