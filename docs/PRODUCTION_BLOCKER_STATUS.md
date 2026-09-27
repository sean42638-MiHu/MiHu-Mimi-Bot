# Final Financial Integrity and Production Blocker Status

Snapshot date: 2026-09-27. No financial data repair was executed. External services were not contacted.

## Phase Gates

| Phase | Status | Evidence |
|---|---|---|
| 1. Financial forensics | TESTED / NOT VERIFIED | [Financial forensic report](FINANCIAL_FORENSIC_REPORT.md). No historical source evidence found for 6 old orders or one opening balance. |
| 2. Reconciliation V2 | IMPLEMENTED / TESTED; HISTORICAL FINDINGS OPEN | SQLite `OPEN_READONLY`; latest read-only run: 4 users, 7 orders, 2 nonzero wallets without ledger, 6 missing payment ledgers, 1 unlinked candidate (order 61), 0 payout rows; wallet mirror 4/4 MATCH. No repair or migration ran. |
| 3. Controlled repair | BLOCKED | Repairs executed: 0. Primary evidence/manual approval absent. |
| 4. Payout semantics | CONTRACT RESOLVED / STATE MACHINE VERIFIED ON TEMP DB; PRODUCTION NOT VERIFIED | Active-only partial unique index, rejected reapplication, batch time/actor/audit, encrypted bank snapshots, and permission gates are tested. Production key provisioning, historical rows, dependency critical, and external operational environment remain blockers. |
| 5. Order writers | VERIFIED (STATIC ARCHITECTURE) / TESTED | 7 Discord command/handler DML writers now call OrderService; architecture guard rejects direct DML. Create/assign/edit/add-time, linked price delta, rollback, and audit paths tested on temp DB. Full external consumer verification still pending. |
| 6. Audit coverage | PARTIAL / TESTED | Wallet/refund/order/VIP/commission/role/profile/email/Discord identity mutation paths use AuditService; remaining gaps listed below. Redaction fixture passes. |
| 7. Wallet mirror | IMPLEMENTED / TESTED | Runtime readers use `user_wallets`; the two compatibility writers remain transaction-gated. Read-only mirror monitor endpoint and four classification fixture pass. |
| 8. Multi-Studio | PARTIAL / TESTED | Runtime fallback guard passes; orders, member list/wallet/VIP and cross-studio order refund HTTP denies tested. Other scoped modules not exhaustively tested. |
| 9. Authenticated HTTP E2E | PARTIAL / TESTED | Temp DB HTTP covers server-derived employee identity/Studio, CSRF, encrypted bank snapshots, self profile, sensitive staff/payroll allow/deny, export, and batch PAID. Not every permission/actor combination is covered. |
| 10. Failure injection/concurrency | PARTIAL / TESTED | Payout reserve/release/settlement/audit and schema/commission/encryption rollback pass on temp DB. Cross-process initial/reapplication, PAID/REJECT race, duplicate transitions, and batch settlement pass. |
| External integrations | BLOCKED_EXTERNAL_ENV | No test Guild or SMTP sandbox/mailbox. |

## Payout Contract Status

The approved payout contract is implemented and covered by service, two-process, migration, reconciliation, and HTTP E2E tests. Requests reserve earnings in `payout_ledger`; PAID records settlement without a second `user_wallets` debit; REJECTED releases the full reserve; employees cannot cancel; one ACTIVE (`pending`/`paid`) request exists per user/Studio/period; REJECTED frees the period for a new request within the open window; no automatic fee is charged. PAID records DB time and authenticated actor, and batch rows share one timestamp/actor with a total/count/IDs audit. Latest production-file read-only scan found 0 payout rows. See [PAYOUT_PRODUCT_DECISIONS.md](PAYOUT_PRODUCT_DECISIONS.md).

Still blocked: production secret provisioning/rotation and review of prior plaintext caches/backups, supply-chain remediation for the critical tar advisory, external service staging/credential rotation, and historical payout rows. Latest read-only scan: 1 user has a bank-account value and 0 account values are encrypted; production migration was not run. The operator PAID confirmation is the accepted platform evidence; no per-row bank reference/proof is required. Existing `completed` rows count as paid to prevent re-withdrawal but remain `LEGACY_PAYOUT_UNVERIFIED`; no historical Ledger was inferred or created.

The explicit `db:migrate` command now passes isolated fresh, existing, rerun, invalid-commission rollback, payout migration, encryption migration, and missing/wrong-key fail-closed tests. Web/Bot startup performs read-only schema readiness only. Production initialization/migration was not run. Commission v1/v3 and legacy talent table rebuilds share a serialized transaction gate, removing the previously reproduced `cannot commit - no transaction is active` loop.

## Order Writer Matrix

| ID | File / operation | Entry and permission | Wallet / Ledger | Commission / Audit / Transaction | Status / risk |
|---|---|---|---|---|---|
| W1 | `handlers/dispatchModalHandler.js` create | Discord modal; initiator/session check | OrderService applies debit with order reference | Commission + order/wallet audits in one transaction | Migrated; actor-derived Studio passed and boss/talent membership validated |
| W2 | `handlers/assignModalHandler.js` create | Discord modal/session | OrderService applies debit with order reference | Commission + order/wallet audits in one transaction | Migrated; Studio validation precedes commit |
| W3 | `handlers/createOrderModalHandler.js` create | Discord modal/session | OrderService applies debit with order reference | Commission + order/wallet audits in one transaction | Migrated |
| W4 | `commands/select.js` assign/price adjustment | Discord administrator permission | OrderService applies signed price delta with unique adjustment reference | Commission + order/wallet audits in one transaction | Migrated; price delta/rollback tested |
| W5 | `commands/edit_order.js` edit | Discord administrator permission | OrderService applies a linked price delta; rejects price changes without tracked payment Ledger or on terminal orders | Commission snapshot + before/after order/wallet audit in transaction | Migrated; service failure/rollback tested; Discord interaction not run |
| W6 | `commands/add_time.js` update | Discord administrator permission | OrderService applies linked price delta; rejects unlinked historical money changes | Commission snapshot + before/after order/wallet audit | Migrated; service path tested; Discord interaction not run |
| W7 | `handlers/modalDispatch.js` legacy pending create | Legacy module; no consumer reference found | No wallet effect, preserved | OrderService creates commission snapshot + order audit | Wrapper retained; consumer/external caller remains unverified |
| S1 | `routes/management/orders.js` update/assign/complete | Web `manage_orders`, CSRF, Studio scope | Refund delegates WalletService | OrderService audit and transaction | Shared service; HTTP path partly tested |
| S2 | `routes/orders.js` legacy update/cancel | Web `manage_orders`, CSRF, Studio scope | Cancel delegates RefundService | OrderService / WalletService | Legacy wrapper retained |
| S3 | `utils/walletService.js` cancel/refund state | Called by OrderService/management wrapper | Atomic wallet + mirror + linked refund Ledger + audit + order cancel | Shared SQLite transaction gate | Implemented; single/batch/concurrency fixtures pass |

Verification: search found **0 direct order DML in `commands/` and `handlers/`**; `tests/order-writer-architecture.test.js` enforces this. Remaining order SQL lives in OrderService and RefundService. Order 61 remains an unlinked ledger candidate; orders 53-58 remain forensic UNKNOWN. No historical data was changed.

## Sensitive Mutation Audit Matrix

| Mutation | Entry / permission | CSRF | Studio scope | Transaction | Audit / redaction | Status |
|---|---|---|---|---|---|---|
| Wallet/recharge adjustment | Management permission / Discord operator | Web global guard | Target authorization | WalletHelper + shared gate | Before/after, operator, studio; secrets redacted | Tested on service fixture |
| Single/batch refund | `manage_orders` / Discord abandon | Web global guard | Order scope | RefundService + shared gate | Linked reference and before/after | Tested; HTTP batch cases partial |
| Order create/assign/update/start/complete | Discord / web wrapper | Web global guard where web | Resolved user/order membership | OrderService + shared gate | Order and wallet audit, linked Ledger | Failure/concurrency fixture tested |
| Order cancel | Web/Discord wrapper | Web global guard where web | Order scope | RefundService | Refund before/after | Tested service-side |
| VIP add/edit/manual role/VIP | `sys_vip` / `member_adjust_vip` | Web global guard | User Studio for member mutation | Shared transaction gate | Before/after, studio | Implemented; no endpoint mutation E2E |
| Automatic VIP recalculation | Wallet/profile helper | N/A | User Studio | Shared transaction gate | Level before/after | Implemented |
| Commission add/edit/delete | `sys_commission` | Web global guard | Trusted actor Studio context | Shared transaction gate | Rates before/after | Implemented; no full endpoint E2E |
| Role/Permission | `sys_roles` | Web global guard | System-global | Shared transaction gate | Role/permission before/after | Implemented; no full endpoint E2E |
| Member/staff role | `member_adjust_vip` / `manage_staff` | Web global guard | Target Studio checks | Shared transaction gate | Before/after; bank/channel values omitted | Implemented |
| Profile/email/bank data | Authenticated profile/email | Web global guard | Self | Shared transaction gate | Profile summary only; email/bank/token values redacted/omitted | Implemented; SMTP remains blocked |
| Discord identity registration/sync | OAuth/register/register-for/member sync | POST sync uses CSRF; OAuth callback is external | Membership where scoped | Shared transaction gate | Public identity before/after, no tokens | Implemented; external flows unverified |
| Discord role mutation | No runtime role API found in commands/handlers | N/A | N/A | N/A | N/A | NOT VERIFIED / no writer located |
| Payout request/paid/reject/batch | `payout.view`, `payout.mark_paid`, `payout.reject`; sensitive/export use separate nodes | Global same-origin CSRF | Employee identity and manager Studio derived server-side | Shared SQLite transaction gate; batch paid all-or-nothing | Encrypted snapshots; audit includes actor/time/amount/state/IDs only; free-text rejection reason scrubbed | Temp service/process/HTTP/startup tests pass; production key not provisioned |
| Payroll data at rest | `PAYROLL_DATA_ENCRYPTION_KEY` from env/secret provider | Startup gate | N/A | Transactional users/payouts field migration + encrypted cache rewrite | AES-256-GCM, random IV/tag; no key in DB/log/repo | Temp migration/tamper/missing-key tests pass; production migration/backup review not run |

No claim is made that every external client or operational maintenance script is covered. Legacy destructive/reset scripts remain maintenance-only and were not run.

## Authenticated HTTP E2E Matrix

All requests used a temporary SQLite DB, test-only Passport session fixture, Discord/SMTP/registration disabled, and external-call tripwires.

| Method / endpoint | Actor | Permission / CSRF / Studio | HTTP | DB / external effect |
|---|---|---|---:|---|
| `GET /management/reconciliation` | Anonymous | No session | 302 login redirect | None |
| `GET /management/reconciliation` | Member, Staff | Authenticated; no payroll permission | 403 | None |
| `GET /management/orders` | Manager A / Manager B | `manage_orders`; trusted Studio A/B | 200 | Each response excludes the other Studio's order |
| `POST /management/orders/cancel/202` | Manager A | Valid session CSRF; order belongs to Studio B | 403 | Order status, wallet, Ledger, Audit unchanged |
| `POST /management/members/update-balance/member-b` | Manager A | Valid CSRF; member belongs to Studio B | 403 | Wallet, mirror, Ledger, Audit unchanged |
| `POST /management/members/update-vip/member-b` | Manager A | Valid CSRF; member belongs to Studio B | 403 | User role/VIP and Audit unchanged |
| `GET /api/withdrawals` / `POST /api/withdrawals/request` | Member A | Authenticated; CSRF on POST; identity/Studio server-derived | 200 / 201 | Pending reserve and audit created; member Wallet unchanged |
| `GET /management/payroll` / `GET /management/payroll/export` | Manager A | Payout permissions; Studio A; sensitive permission required for raw data | 200 / 200 | Only Studio A payout rows; XLSX generated per request and export audited |
| `POST /management/payroll/payouts/batch-paid` | Manager A | Valid CSRF; selection includes Studio B payout | 400 | Entire batch remains pending; no partial settlement |
| `POST /management/payroll/payouts/:id/paid` | Manager A | Valid CSRF; target belongs to Studio B | 400 | Foreign payout remains unchanged |
| `POST /management/payroll/payouts/:id/paid` | Manager A | Valid CSRF; Studio A pending target | 200 | State/audit/journal updated; member Wallet unchanged |
| `POST /management/payroll/payouts/batch-paid` | Manager A | Valid CSRF; two Studio A pending withdrawals | 200 | Both paid with identical `paid_at`/`processed_by`; total/count audit; Wallet unchanged |
| `GET /management/staff` | Limited staff manager / Manager A | `manage_staff` without / with `payout.view_sensitive` | 200 / 200 | No-sensitive response has no raw account payload; authorized response decrypts only after permission gate |
| `POST /system/bot-settings/sync` | Admin | Missing / invalid / other-session CSRF | 403 each | No Discord REST calls |
| `POST /system/bot-settings/sync` | Admin | Valid session CSRF and permission | 410 protected deployment-only response | No Discord REST calls |

This verifies selected auth/CSRF/studio gates and payout success/denial paths over real HTTP, not every permission/actor combination or external payment execution.

## Wallet Mirror Migration Status

Canonical account: `user_wallets`. Ledger: `wallet_transactions`. Compatibility mirror: `users.balance` and associated counters.

- Runtime readers: `user_wallets` only in wallet services/helpers, order handlers, self-register, VIP/discount helpers, Members, dashboard, and wallet page. Wallet history falls back to the canonical value already supplied by the wallet view model when a legacy event has no `balance_after`.
- Runtime writers (2 services): `utils/walletHelper.js` (`adjustUserWallet`) and `utils/walletService.js` (`applyWalletDeltaInTransaction` / RefundService). Both update `user_wallets`, the compatibility mirror, Ledger, and audit inside the shared transaction gate.
- Direct runtime legacy financial writers outside those services: **0**. Compatibility mirror writes remain **2 service paths** by design for existing consumers.
- Migration/maintenance writers: `database.js` first-time migration/seed and `resetWallets.js`; maintenance script was not run.
- Read-only monitoring: `GET /management/reconciliation/wallet-mirror`, classified as `MATCH`, `LEGACY_EXPECTED`, `MISMATCH`, or `UNKNOWN`; it uses SQLite `OPEN_READONLY` and never repairs.
- Monitor fixture: all 4 classifications verified; no-write invariant verified. Current read-only snapshot: 4/4 users `MATCH` between canonical balance and compatibility mirror.
- Safe to remove `users.balance`: **NO**. Mirror diff monitoring is now implemented, but long-term consumer-free observation period has not started.

Exact consumer count is not asserted from text-match totals because `SELECT u.*`, EJS aliases, and static showcase data are not equivalent to balance reads.

## Multi-Studio / HTTP / External

Runtime Studio fallback matches: **0** across routes/commands/handlers/utils. The runtime architecture guard passes. Remaining literal Studio 1 references are legacy `database.js` migrations/backfills and `reset_commissions.js` maintenance code; no maintenance script was run.

Authenticated HTTP fixture also covers encrypted self-profile/staff/payout display, manager XLSX export, spoofed employee identity rejection, Studio mismatch, all-or-nothing batch denial, and successful two-row batch settlement. Cross-Studio payouts remain unchanged; member Wallet remains unchanged on request and PAID. This is a selected matrix, not every sensitive endpoint.

Failure injection on isolated DB covers wallet update, Ledger insert, order insert/update, commission service resolution, audit insert, payout reserve/settlement/release, and batch middle-item rollback. Two independent Node child processes sharing one OS-temp SQLite file verify refund/wallet races plus simultaneous payout request, paid/reject races, and duplicate batch settlement. No historical payout rows were repaired.

SMTP and Discord remain `EXTERNAL_ENV_REQUIRED` until a sandbox mailbox and Development/Test Guild exist. Credential rotation remains `MANUAL_SECURITY_ACTION_REQUIRED` until the user confirms each provider rotation. Main Development now uses sqlite3 6.0.1/tar 7.5.22; `npm audit` and `npm audit --omit=dev` are both 0. The prior tar Critical was install/build-time reachable but not application request/runtime reachable; it is removed from the Development dependency tree. No Production/Staging runtime currently exists, so same-platform certification is `PENDING_PLATFORM_SELECTION`, not a code failure. See [DEPENDENCY_SECURITY_REPORT.md](DEPENDENCY_SECURITY_REPORT.md), [TAR_CRITICAL_REMEDIATION.md](TAR_CRITICAL_REMEDIATION.md), and [SQLITE3_MAJOR_UPGRADE_ASSESSMENT.md](SQLITE3_MAJOR_UPGRADE_ASSESSMENT.md).

## Regression Evidence

- `npm test`: 24/24 PASS.
- JavaScript syntax: 106 repository files PASS (dependencies excluded).
- EJS compile: 50 templates PASS.
- Diagnostics: PASS.
- `git diff --check`: PASS (Git reports LF-to-CRLF working-copy warnings only).
- Test DB: OS temporary directory only; test-mode production DB path is rejected.
- Discord login/REST, SMTP send, command registration: disabled/tripped in tests.
- Historical financial repairs: 0.
- `scripts/payrollEncryptionStatus.js`: SQLite `OPEN_READONLY`, counts only, no-write/secret-value-output tests pass.
- `tests/sqlite-regression.test.js`: sqlite3 6.0.1 Development baseline passes CRUD, prepared statements, commit/rollback, constraints, PRAGMA, concurrent connections, and reopen/read.

## Closure Classification

| Classification | Items |
|---|---|
| CODE_VERIFIED | Payout state machine/active index; startup and commission migrations on isolated DB; AES-256-GCM/fail-closed migration; read-only PII scanner; reconciliation checks; sqlite3 6.0.1 Development baseline and tar Critical removal; 24-test suite. |
| DEPLOYMENT_ACTION_REQUIRED | Provision `PAYROLL_DATA_ENCRYPTION_KEY` in the secret provider; backup/restore; maintenance/write controls; run [PRODUCTION_PII_MIGRATION_RUNBOOK.md](PRODUCTION_PII_MIGRATION_RUNBOOK.md); verify `node scripts/payrollEncryptionStatus.js --require-encrypted`. Production key/migration not performed. |
| MANUAL_SECURITY_ACTION_REQUIRED | Prior plaintext cache/backup/export inventory and retention; key recovery/rotation; provider credential rotation; see [PII_STORAGE_INVENTORY.md](PII_STORAGE_INVENTORY.md), [PII_KEY_ROTATION_RUNBOOK.md](PII_KEY_ROTATION_RUNBOOK.md), [CREDENTIAL_ROTATION_CHECKLIST.md](CREDENTIAL_ROTATION_CHECKLIST.md). |
| EXTERNAL_ENV_REQUIRED | SMTP sandbox/mailbox and dedicated Discord Test Bot/Guild; see [SMTP_STAGING_CHECKLIST.md](SMTP_STAGING_CHECKLIST.md) and [DISCORD_STAGING_CHECKLIST.md](DISCORD_STAGING_CHECKLIST.md). |
| MANUAL_FINANCIAL_APPROVAL_REQUIRED | Original evidence/dual approval for 2 wallet differences, 6 completed orders, and Order 61; see [HISTORICAL_FINANCIAL_APPROVAL_CHECKLIST.md](HISTORICAL_FINANCIAL_APPROVAL_CHECKLIST.md). No repair or inferred link is authorized. |
| PENDING_PLATFORM_SELECTION | No Production/Staging runtime exists yet. When hosting is chosen, verify its OS/architecture/Node and repeat clean install/native/DB certification on that platform. |
| BLOCKED | No current Development code/dependency Critical remains. Production release is still NO-GO due deployment, security, external-environment, and manual-financial gates. |

Operational sequence: [GO_LIVE_RUNBOOK.md](GO_LIVE_RUNBOOK.md). Full category summary: [FINAL_PRODUCTION_GATE_MATRIX.md](FINAL_PRODUCTION_GATE_MATRIX.md).

## Gate

```text
FINANCIAL INTEGRITY  NOT VERIFIED
PAYOUT               VERIFIED ON TEMP DB; PRODUCTION DEPLOYMENT/HISTORY/DEPENDENCY/EXTERNAL GATES BLOCK RELEASE
SENSITIVE DATA       VERIFIED ON TEMP DB; PRODUCTION KEY/DB MIGRATION NOT RUN; 1 populated bank account remains plaintext
ORDER WRITERS        VERIFIED STATIC ARCHITECTURE; SERVICE HTTP/EXTERNAL PATHS PARTIAL
AUDIT                PARTIAL; remaining endpoints/external maintenance paths unverified
WALLET MIRROR        PARTIAL; monitor is read-only, compatibility writers remain
AUTHORIZATION        PARTIAL HTTP E2E; full sensitive endpoint matrix not verified
CSRF                 PARTIAL HTTP E2E; selected session token cases pass
MULTI-STUDIO         PARTIAL HTTP E2E; selected orders/member/wallet/VIP cases pass
FAILURE INJECTION    PARTIAL TESTED on isolated DB; payout/commission/encryption rollback and atomic batch covered
CONCURRENCY          PARTIAL TESTED cross-process refund/batch/complete/wallet and payout reapply/terminal races
RECONCILIATION       READ-ONLY CHECKED; 2 no-ledger nonzero wallets + 6 missing payments + 1 unlinked candidate; 0 payout rows
DEPENDENCY CRITICAL  CLEARED FOR DEVELOPMENT; sqlite3 6.0.1 / tar 7.5.22, audit 0
PRODUCTION PLATFORM  PENDING_PLATFORM_SELECTION; no Production/Staging runtime exists
EXTERNAL             BLOCKED_EXTERNAL_ENV
ROTATION             MANUAL_ROTATION_REQUIRED
```

Production status remains **NOT PRODUCTION READY**. No historical repair was executed.
