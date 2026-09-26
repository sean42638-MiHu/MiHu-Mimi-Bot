# Final Production Gate Matrix

Snapshot: 2026-09-27. Production payout count is 0. No production payout, migration, encryption key, or historical repair was created/executed.

| Gate | Classification | Current evidence / action |
|---|---|---|
| Payout contract/state machine | CODE_VERIFIED | 24-test suite includes service, HTTP, schema, failure, active-period reapplication, and cross-process coverage. Production payout workflow remains unexercised because there are 0 rows and no bank integration. |
| SQLite Development baseline | CODE_VERIFIED | sqlite3 6.0.1/tar 7.5.22, audits 0, 24/24 tests, and CRUD/transaction/concurrency/reopen baseline pass on Windows x64/Node 24.21.0. |
| Schema/startup migration | CODE_VERIFIED | Fresh/existing/rerun/partial/failure and commission startup tests pass on OS-temp DB. Production migration was not run. |
| PII encryption/fail-closed | CODE_VERIFIED | AES-256-GCM, env-only key, startup gate, user/payout migration, encrypted cache rewrite, wrong/missing-key rollback verified on temp DB. |
| Production encryption rollout | DEPLOYMENT_ACTION_REQUIRED | Stage secret-provider key, backup/restore, maintenance/write control, pre/post count scan, and run [PRODUCTION_PII_MIGRATION_RUNBOOK.md](PRODUCTION_PII_MIGRATION_RUNBOOK.md). Production bank values are currently plaintext. |
| Key rotation/recovery | MANUAL_SECURITY_ACTION_REQUIRED | Current envelope has no key ID and code supports one key. Do not rotate until versioned keyring/migration exists; follow [PII_KEY_ROTATION_RUNBOOK.md](PII_KEY_ROTATION_RUNBOOK.md). |
| Plaintext cache/backups/exports | MANUAL_SECURITY_ACTION_REQUIRED | `data/users.json` is ignored/untracked; inventory backup snapshots, downloads, logs, and local copies. Do not automatically delete. See [PII_STORAGE_INVENTORY.md](PII_STORAGE_INVENTORY.md). |
| Production platform compatibility | PENDING_PLATFORM_SELECTION | Owner confirms no Production/Staging runtime is established; repeat same-platform install/native/DB certification when hosting is selected. |
| Critical sqlite3/tar advisory | CODE_VERIFIED for Development | sqlite3 6.0.1/tar 7.5.22 is main Development baseline; full/prod audits 0. Production platform certification is deferred. See [SQLITE3_MAJOR_UPGRADE_ASSESSMENT.md](SQLITE3_MAJOR_UPGRADE_ASSESSMENT.md). |
| SMTP staging | EXTERNAL_ENV_REQUIRED | Sandbox endpoint/mailbox/rotated staging credential required; no production SMTP tests run. |
| Discord staging | EXTERNAL_ENV_REQUIRED | Dedicated Test Bot/Guild/channels/roles required; Production Guild was not used. |
| Provider credential rotation | MANUAL_SECURITY_ACTION_REQUIRED | Discord Bot, OAuth, and SMTP values must be revoked/provisioned by owners in provider/secret systems; no values recorded here. |
| Historical financial differences | MANUAL_FINANCIAL_APPROVAL_REQUIRED | 2 non-zero wallets without Ledger, 6 orders missing payment Ledger, Order 61 candidate remain unchanged. Require original evidence and approval; see [HISTORICAL_FINANCIAL_APPROVAL_CHECKLIST.md](HISTORICAL_FINANCIAL_APPROVAL_CHECKLIST.md). |
| Overall production release | BLOCKED | Remains **NOT PRODUCTION READY** until Production platform compatibility, deployment actions, external gates, key plan, and financial approvals are complete. Development dependency Critical is resolved; Production platform certification is pending selection. |

This matrix separates code verification from operator/security/finance deployment duties. No category is downgraded to achieve a GO decision.
