# Payout Product Decisions

Status: **CONTRACT IMPLEMENTED / PRODUCTION NOT VERIFIED**. The user-approved reserve, settlement, rejection, permission, and monthly request rules are implemented in `services/payoutService.js`, with the state journal stored separately in `payout_ledger`. No historical payout rows or member Wallet balances were repaired or rewritten.

## Resolved Contract

| ID | Status | Decision | Implementation |
|---|---|---|---|
| Q1 | RESOLVED | A successful request reserves the requested amount immediately from available salary. | A pending payout reduces available earnings and increases pending/reserved amount in the same transaction. |
| Q2 | RESOLVED | Reservation is separate from the member cash Wallet. | `payout_ledger` records `PAYOUT_RESERVE`, `PAYOUT_PAID`, and `PAYOUT_RELEASE`; `user_wallets` and `wallet_transactions` are not mutated by payout transitions. |
| Q3-Q5 | RESOLVED | PAID is an administrator confirmation after bank transfer; platform evidence is `paid_at` and `processed_by`. No per-withdrawal bank reference/proof is required. | Only PENDING→PAID is allowed. Each row stores the same DB-generated batch timestamp and authenticated administrator; no second Wallet debit or manual proof field exists. The bank retains transfer records. |
| Q6 | RESOLVED | REJECTED releases the entire reserved amount. | A mandatory reason, operator, audit record, and full `PAYOUT_RELEASE` event are written atomically. |
| Q7 | RESOLVED | Employees cannot cancel requests. | No employee cancellation route exists. |
| Q8 | RESOLVED | No automatic platform fee in v1. | No `PAYOUT_FEE`, fee Ledger, or Wallet deduction. Income displays the bank-808 operational fee notice only. |
| Q9 | RESOLVED | Window is each configured start day at 00:00 through end day at 23:59:59 in platform timezone; minimum 100; max is server-calculated available salary. | Defaults: days 2-6, minimum 100, `Asia/Taipei`; backend validation is authoritative. |
| Q10 | RESOLVED | At most one ACTIVE (`pending` or `paid`) payout per user/Studio/period; REJECTED frees eligibility for a new row during an open window. | SQLite partial unique index covers `pending`/`paid`; REJECTED rows remain immutable history; transaction check and independent-process tests preserve the active uniqueness rule. |
| Access/audit | RESOLVED | Payout viewing, sensitive data, export, mark-paid, and reject each have separate permission nodes. | Endpoints enforce permissions, operator identity comes from the authenticated session, mutations are audited, and batch PAID is all-or-nothing. |

## Open Decisions And Blockers

| ID | Unresolved item | Current handling |
|---|---|---|
| Key rotation | Rotation procedure and historical key retention. | AES-256-GCM uses `PAYROLL_DATA_ENCRYPTION_KEY`; missing/wrong key fails startup. Rotation tooling and secret-provider operations remain a pre-production task. |
| Historical records | Whether/how legacy `completed` rows should be linked to new payout journal entries. | No repair or inferred ledger is created. Legacy completed amounts remain counted as paid for availability and are reported `LEGACY_PAYOUT_UNVERIFIED`. |
| Credentials/external services | Discord and SMTP staging, plus provider credential rotation. | Remains `BLOCKED_EXTERNAL_ENV` and `MANUAL_ROTATION_REQUIRED`. |
| Self-approval | Whether an operator may mark PAID or reject a payout they requested themselves (including batch PAID containing their own payout). | **RESOLVED (business owner, 2026-09-28): allowed.** No code block. Every transition keeps `payouts.processed_by`, a `payout_ledger` row with `operator_id`, and `WITHDRAWAL_REQUESTED`/`WITHDRAWAL_PAID`/`WITHDRAWAL_REJECTED`/`WITHDRAWAL_BATCH_PAID` audit rows with operator and target, so self-processing is identifiable after the fact. |
| Duty separation | Whether payout execution (`export`/`view_sensitive`) and approval (`mark_paid`/`reject`) must be held by different roles. | **RESOLVED (business owner, 2026-09-28): not required.** The single 店長兼財務 holds `admin` with all five payout permissions plus `staff_view_payroll`. Preflight reports combined-duty roles but does not fail them. `cfo` is not defined in the Production roles file; its remaining code references are display/filter only and fail closed. |

Passing tests does not establish production readiness. See [PRODUCTION_BLOCKER_STATUS.md](PRODUCTION_BLOCKER_STATUS.md).
