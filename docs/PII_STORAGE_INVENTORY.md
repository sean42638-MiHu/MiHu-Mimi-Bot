# PII Storage Inventory

Status: **Inventory / plan only. No file deletion, backup deletion, or production scan was performed beyond count-only read-only queries.** Do not place account values or identity documents in this document.

| Location | Classification | Contains PII? | Encrypted? | Access control | Retention | Deletion / replacement | Manual action |
|---|---|---|---|---|---|---|---|
| Production `users` table (`real_name`, `bank_*`) | ACTIVE | Yes; read-only scan found 1 populated bank account field | No at last scan (0 encrypted account fields) | Application auth/permissions; DB operator access | Existing DB policy | Apply approved PII migration; retain backup per policy | Provision secret; schedule migration |
| Production `payouts` snapshot columns | ACTIVE | Possible; current payout count is 0 | New writes use AES-GCM; production rows were not changed | `payout.view_sensitive` / `payout.export` for raw reads | Financial retention policy | New writes encrypted; legacy rows handled by startup migration | Confirm backup/retention policy |
| `data/users.json` | CACHE | Can mirror all user columns | Startup rewrites it to ciphertext; current production cache was not inspected | Host filesystem; Git ignored and untracked | No verified policy | Replace with encrypted cache during migration; review prior copies | Inventory paths/permissions/backups without outputting content |
| Request-time Payroll XLSX response | EXPORT | Yes: name, bank/branch/account, amount | Workbook content is not application-encrypted | Authenticated `payout.export` + `payout.view_sensitive`, Studio-scoped; audit logged | Browser/client download policy | No server-side file; recipients manage downloaded copies | Define recipient/download retention and secure transfer |
| Browser downloads / manual spreadsheets | EXPORT / UNKNOWN | May contain payroll PII | Unknown | Client/device/user-controlled | Unknown | Follow company endpoint/device policy; do not auto-delete | Inventory approved finance locations |
| Legacy CSV / manually generated exports | EXPORT / UNKNOWN | May contain historical payroll PII | Unknown | Finance/operator-controlled | Unknown | Current payout endpoint generates request-time XLSX only; do not assume older copies are absent | Search approved export locations by metadata/name and assign owner/retention |
| `audit_logs` | LOG | IDs, amounts, status, actor/time; no full bank/name values intended | DB-level protection only; values are metadata, not encrypted by the PII field envelope | Restricted management permission | Existing audit retention policy | Retain for financial audit; no PII-bearing payload expected | Verify retention/access policy |
| Application logs / debug logs | LOG | No complete bank/name/ID values intended; SQL failure metadata may exist | Host/log provider controls | Operations/log platform | Unknown | Do not purge automatically; review retention and access | Search metadata/field names only, never dump values |
| DB backups / server snapshots | BACKUP / UNKNOWN | Yes if created before PII migration | Unknown; backup encryption is deployment-managed | Backup provider/DBA access | Unknown | Do not delete automatically; apply backup encryption/expiry/legal hold policy | Inventory snapshots and mark pre/post migration versions |
| `mihu.db`, local `database.sqlite`, dev/staging copies | DEVELOPMENT COPY / UNKNOWN | May contain historical/user data | Unknown | Workspace/host access; DB files ignored by Git where covered | Unknown | Do not inspect/copy to test; handle under data owner policy | Identify owner, scope, encryption, retention |
| CSV/static public exports, uploads, temp files, old migration artifacts | UNKNOWN | No active payout public export found; other copies unverified | Unknown | Varies | Unknown | No automatic deletion | Check deployment paths and artifact stores by metadata/count only |
| CI artifacts/test outputs | TEMPORARY | Tests use synthetic values; verify future fixtures stay synthetic | Test-specific | CI ACL | CI retention | Follow CI expiry policy | Confirm artifacts do not include production DB/cache |
| National ID / identity number column | NOT PRESENT | No field/column found in inspected schema/routes/templates | N/A | N/A | N/A | Do not add without product/security review | None |

## Required Closure Actions

- Run [PRODUCTION_PII_MIGRATION_RUNBOOK.md](PRODUCTION_PII_MIGRATION_RUNBOOK.md) only after secret/backup/maintenance approvals.
- Identify prior plaintext backups/cache copies and their owners/retention. Do not automatically remove them.
- Set explicit retention, export handling, log access, backup encryption, and downloaded-file procedures before go-live.
