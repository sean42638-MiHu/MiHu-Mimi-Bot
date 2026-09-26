# Financial Forensic Investigation

Generated: 2026-09-27. Investigation used SQLite `OPEN_READONLY`; no production rows were inserted, updated, or deleted.

## Snapshot Change

The prior reconciliation snapshot showed 3 non-zero wallets without ledger and 6 completed orders without a linked payment ledger. The current database is different: one of those wallets now has two ledger entries and a new order 61 exists. The current snapshot has 2 non-zero wallets with zero ledger rows and 7 completed orders without an explicit order-reference payment. Do not compare these counts as if the database were static.

## Wallet Findings

`user_wallets` has no `created_at` column. `updated_at` is the only wallet timestamp; it is not evidence of account creation. `wallet_transactions` contains two rows total, both for user `1529507781428903936`. Current `audit_logs` contains the corresponding two `wallet_adjustment` records only.

| user_id | studio_id | current balance / mirror | wallet timestamp | Ledger | Evidence and classification |
|---|---:|---:|---|---:|---|
| `604610298581876746` | 1 | 20,754 / 20,754; bonus 246 | 2026-09-26 14:31:55 | 0 | Five recharge records (#1-5) total 36,389 with 246 bonus. `manual_deposited` is 53,389 and `manual_spent` 18,888; source of the 17,000 deposited-counter gap and current balance is not established. No related payout or audit. **UNKNOWN**, low confidence. `mihu.db` has the same user at zero balance, negative manual-deposited counter, 18 net-zero topups, no orders/payouts, and no wallet ledger schema; it is a contradictory possible predecessor snapshot, not a proven migration source. |
| `manager-b` | 1 | 6,666 / 6,666; bonus 0 | 2026-09-26 16:06:17 | 0 | Topup #8 is a manual recharge of 6,666 by the admin at exactly the wallet update timestamp; `manual_deposited` is 6,666 and `manual_spent` is 0. No payout or audit. **MANUAL_ADJUSTMENT_WITHOUT_LEDGER**, medium-high confidence that the topup is the recorded source; reason for absent ledger is unknown. |
| `1529507781428903936` | 1 | 16,390 / 16,390; bonus 0 | 2026-09-27 00:12:47 | 2 | This was one of the previous no-ledger wallets, but now has payment ledger #5 (-8,888) and recharge ledger #6 (+5,200), with matching audit rows #3 and #4. Ledger-window opening balance is 20,078 and arithmetic reconciles to 16,390. Topups #6 (10,500), #7 (21,800), #11 (5,200) exist; the opening source and deposited-counter difference are not established. Current classification for opening provenance: **UNKNOWN**, low confidence. |

No wallet repair or opening-balance transaction was created. Existing `users.balance` mirrors match `user_wallets.balance` for these three users in this snapshot.

## Completed Order Findings

The `orders` schema has no `updated_at` column. `end_time` is used as the available completion timestamp. `mihu.db` contains no orders. Current `data/orders.json` is only a cache/export and is not evidence that missing rows never existed.

| order_id | user_id | studio | created / completed | original / discount / final | Evidence and classification |
|---:|---|---:|---|---:|---|
| 53 | `1529507781428903936` | 1 | 2026-09-26 07:13:35 / 2026-09-25T23:14:23Z | 3,200 / 0 / 3,200 | No payment/refund ledger for this user at this time; Discord IDs are NULL. **UNKNOWN**. |
| 54 | `1529507781428903936` | 1 | 2026-09-26 07:15:30 / 2026-09-26 07:15:37 | 500 / 0 / 500 | No payment/refund ledger; Discord IDs are NULL. **UNKNOWN**. |
| 55 | `1529507781428903936` | 1 | 2026-09-26 07:30:50 / 2026-09-25T23:31:13Z | 300 / 0 / 300 | No payment/refund ledger; Discord IDs are NULL. **UNKNOWN**. |
| 56 | `1529507781428903936` | 1 | 2026-09-26 07:39:06 / 2026-09-25T23:39:42Z | 520 / 0 / 520 | No payment/refund ledger; Discord IDs are NULL. **UNKNOWN**. |
| 57 | `1529507781428903936` | 1 | 2026-09-26 14:08:56 / 2026-09-26T06:09:23Z | 500 / 0 / 500 | No payment/refund ledger; Discord IDs are NULL. **UNKNOWN**. |
| 58 | `1529507781428903936` | 1 | 2026-09-26 15:56:06 / 2026-09-26T07:56:51Z | 888 / 178 / 710 | No payment/refund ledger; Discord IDs are NULL. **UNKNOWN**. |
| 61 | `1529507781428903936` | 1 | 2026-09-27 00:08:35 / 2026-09-26T16:09:53Z | 8,888 / 0 / 8,888 | Ledger #5 is -8,888 at 2026-09-26 16:08:35 UTC, with a same-time audit whose reason is `大廳派單扣款 (陪玩單)`; the UTC ledger time is the same instant as the order's local-time creation. That unique reason appears in `handlers/dispatchModalHandler.js`, which debits through `adjustUserWallet` before directly inserting the order. **DISCORD_WRITER_GAP**, high confidence. Payment effect is supported, but the ledger has `reference_type='wallet'` and no `reference_id`; completion has no order audit. |

Orders 53-58 total 5,730, with no attributable payment transaction, refund, payout, or order-targeted audit found. Their writer cannot be determined from the available records. The repository has several Discord create handlers and legacy order import/update paths, but code presence is not evidence that one created these specific records.

## Legacy and Cache Evidence

- Legacy `mihu.db`: one user record for `604610298581876746`, zero balance, `manual_deposited=-134289`, 18 topups summing to zero, no orders/payouts, and no ledger tables. This does not reconcile to the current database.
- `data/users.json` shows a stale balance for `1529507781428903936` matching the post-payment, pre-recharge amount 11,190; it is not a transaction source.
- The two current wallet audits identify operator/action and before/after values for order 61's debit and the later recharge. No audit exists for the two no-ledger wallets or orders 53-58.
- Current `payouts` has no records. No separate commission or settlement ledger exists; commission snapshots live on orders.

## Classification and Repair Plan

Reconciliation V2 was run against the current file through SQLite `OPEN_READONLY`: 4 users, 7 orders, 0 payouts, 2 `NO_LEDGER_NONZERO_WALLET`, 6 `MISSING_PAYMENT_LEDGER`, and 1 `UNLINKED_PAYMENT_CANDIDATE` (order 61 / ledger #5). User `1529507781428903936` has a matching ledger window but remains `NOT_VERIFIED` because its opening-balance source is unknown. `repairs_performed=0`.

| Record | Classification | Evidence | Proposed action | Balance / ledger / order impact | Manual approval |
|---|---|---|---|---|---|
| Wallet `604610298581876746` | UNKNOWN | Topups exist, but no ledger/audit; counters do not reconcile to documented topups; legacy DB conflicts | Obtain statements and historical export/backup provenance; do not synthesize opening balance | None until evidence establishes an opening and approved reference | Required |
| Wallet `manager-b` | MANUAL_ADJUSTMENT_WITHOUT_LEDGER | Topup #8 equals balance and deposited counter, with same timestamp; no ledger/audit | Confirm whether this is a fixture or authorized manual recharge, then design a separately approved repair | None now | Required |
| Wallet `1529507781428903936` opening | UNKNOWN | Current ledger window balances, but opening 20,078 predates first tracked transaction | Find the source of opening funds and 4,300 deposited-counter difference | None now | Required |
| Orders 53-58 | UNKNOWN | No linked or amount/time candidate ledger; legacy DB has no orders; no order audit | Retrieve Discord/application exports, bank statements, operator logs, and pre-ledger snapshots | None now | Required |
| Order 61 | DISCORD_WRITER_GAP | Same amount/time/user, audit reason and unique dispatch handler source | Future writer must attach order reference atomically; do not rewrite historical ledger without approval | None now | Required for any historical link repair |

**Repairs executed: 0.** No proposed repair is safe to execute from current evidence. Opening-balance records and historical ledger inserts remain pending manual approval and primary-source evidence.

## Financial Repair Plan (Dry Run Only)

No idempotency key is issued and no repair action is executable from this plan. Every `repair_id` below is a planning label only. All balance/order deltas are zero unless a future manually approved plan is reviewed and separately applied.

| repair_id | Record / classification | Reason and evidence | Before state | Planned after state | Balance delta | Ledger delta | Order delta | Audit record | idempotency_key | Manual approval |
|---|---|---|---|---|---:|---:|---:|---|---|---|
| PLAN-WALLET-604610298581876746 | Wallet / UNKNOWN | Topups and counters conflict; legacy DB contradicts current snapshot | Balance 20,754; no Ledger | No change; continue source-document investigation | 0 | 0 | 0 | None until approved | NOT_ISSUED | YES |
| PLAN-WALLET-MANAGER-B | Wallet / MANUAL_LEGACY_OPERATION | Topup #8 exactly matches current balance/deposited value and timestamp, but no before-balance evidence | Balance 6,666; mirror 6,666; no Ledger | No change until source and prior balance are confirmed | 0 | 0 | 0 | If later repaired: audited historical topup repair | NOT_ISSUED | YES |
| PLAN-WALLET-1529507781428903936 | Wallet opening / UNKNOWN | Ledger arithmetic matches from inferred 20,078, but opening provenance is unknown | Balance 16,390; two Ledger rows | No change; locate approved opening source | 0 | 0 | 0 | None until approved | NOT_ISSUED | YES |
| PLAN-ORDERS-53-58 | Six orders / UNKNOWN | No attributable payment evidence or writer proof | Six completed orders; no linked payment Ledger | No change; obtain primary source records | 0 | 0 | 0 | None until approved | NOT_ISSUED | YES |
| PLAN-ORDER-61-LINK | Order 61 / UNLINKED_EXISTING_TRANSACTION | Ledger #5 candidate matches member/studio/operator/time/amount and dispatch reason, but reference is null | One existing -8,888 wallet Ledger; order 61 completed | Candidate remains unresolved; if independently confirmed, add reference/audit metadata only | 0 | 0 new rows | 0 | Required before/after reference-link audit | NOT_ISSUED | YES |

## Financial Resolution Matrix

| Record type | Record ID | Current state | Evidence | Classification | Confidence | Repair required? | Proposed repair | Balance impact | Ledger impact | Audit requirement | Manual approval? |
|---|---|---|---|---|---|---|---|---:|---|---|---|
| Wallet | `604610298581876746` | Balance 20,754; no Ledger; mirror matches | Topups #1-5 total 36,389 + 246 bonus; manual deposited 53,389; `mihu.db` conflicts | UNKNOWN | Low | No automated repair; obtain bank statements and prior exports | 0 | 0 until proven | Required for any later repair | YES |
| Wallet | `manager-b` | Balance 6,666; no Ledger; mirror matches | Topup #8 is 6,666 by admin at wallet update timestamp; deposited counter 6,666 | MANUAL_LEGACY_OPERATION | Medium-high for source event; authorization/business purpose unconfirmed | Candidate repair only | If approved, append one historical topup Ledger/audit with a new repair reference; do not change balance | 0 | +1 only after approval | Before/after, source topup #8, operator, reason, repair ID | YES |
| Wallet opening | `1529507781428903936` | Two Ledger rows; current ledger window ends at 16,390 | First tracked balance_before 20,078; debit -8,888 and credit +5,200; topups #6/#7/#11 exist | UNKNOWN | Low for opening provenance; high for ledger arithmetic | No | Obtain source for 20,078 opening and 4,300 deposited-counter gap; do not synthesize opening | 0 | 0 | Required if opening is later approved | YES |
| Completed order | `53` | Completed, final 3,200; no linked or unlinked candidate | No matching user payment/refund Ledger, no order audit, no Discord message IDs; absent in `mihu.db` | UNKNOWN | Low | No | Obtain timestamped source records; no inferred payment | 0 | 0 | Required if later repaired | YES |
| Completed order | `54` | Completed, final 500; no linked or unlinked candidate | No matching user payment/refund Ledger, no order audit, no Discord message IDs; absent in `mihu.db` | UNKNOWN | Low | No | Obtain timestamped source records; no inferred payment | 0 | 0 | Required if later repaired | YES |
| Completed order | `55` | Completed, final 300; no linked or unlinked candidate | No matching user payment/refund Ledger, no order audit, no Discord message IDs; absent in `mihu.db` | UNKNOWN | Low | No | Obtain timestamped source records; no inferred payment | 0 | 0 | Required if later repaired | YES |
| Completed order | `56` | Completed, final 520; no linked or unlinked candidate | No matching user payment/refund Ledger, no order audit, no Discord message IDs; absent in `mihu.db` | UNKNOWN | Low | No | Obtain timestamped source records; no inferred payment | 0 | 0 | Required if later repaired | YES |
| Completed order | `57` | Completed, final 500; no linked or unlinked candidate | No matching user payment/refund Ledger, no order audit, no Discord message IDs; absent in `mihu.db` | UNKNOWN | Low | No | Obtain timestamped source records; no inferred payment | 0 | 0 | Required if later repaired | YES |
| Completed order | `58` | Completed, original 888, discount 178, final 710; no linked or unlinked candidate | No matching user payment/refund Ledger, no order audit, no Discord message IDs; absent in `mihu.db` | UNKNOWN | Low | No | Obtain timestamped source records; no inferred payment | 0 | 0 | Required if later repaired | YES |
| Completed order candidate | `61` / Ledger `5` | Completed, final 8,888; Ledger #5 is -8,888 with no `reference_id` | Same user/studio/operator; same amount and timestamp; audit reason matches unique dispatch handler; reference is `wallet`, not `order` | UNLINKED_EXISTING_TRANSACTION | High-confidence candidate, not definitive link | No automatic repair | If independently confirmed, metadata/reference-only link; no second transaction | 0 | No new money/ledger row; append repair audit and idempotency record only if approved | REQUIRED |

Order 61 remains `UNRESOLVED CANDIDATE`: matching time and amount plus writer/audit evidence is strong, but no order reference exists. No repair or reference rewrite was executed.

## Payout Financial Semantics

The existing `payouts` table only has `user_id`, `amount`, `status`, and `created_at`; there are no payout mutation routes or records. The current `income` view subtracts completed payout amounts from earned income, while payroll is a read/export of completed-order earnings. Request-time debit/reserve, approve, processing, completion, rejection, and cancellation wallet/ledger effects are **UNKNOWN**. State machine implementation is blocked pending an explicit product/finance contract.
