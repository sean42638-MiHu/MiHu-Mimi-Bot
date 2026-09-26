# SQLITE3 Major Upgrade Assessment

Date: 2026-09-27. **DEVELOPMENT_BASELINE = VERIFIED; PRODUCTION_PLATFORM_COMPATIBILITY = PENDING_PLATFORM_SELECTION.** The owner confirms no formal Production or Staging runtime has been established. The intended Development/Local Test target is Windows x64, Node 24.21.0. No same-platform Production claim is made. No production DB/cache, credentials, payouts, or PII rows were used/changed.

## Deployment Environment Evidence

| Requested evidence | Repository evidence | Result |
|---|---|---|
| Hosting/provider | No deploy manifest found; owner confirms no Production/Staging runtime exists yet | NOT SELECTED |
| Development OS / architecture | Owner-confirmed local development target | Windows x64 |
| Development Node | Owner-confirmed local development target | v24.21.0 |
| Production OS / architecture / Node | No Production runtime or deploy config exists | TBD / DEFERRED |
| CPU architecture | Development target | x64 |
| Production Node | `package.json` has no `engines`; Production Node TBD | DEFERRED |
| Package manager/install | npm lockfile v3; scripts include `npm start`/`node index.js`, `bot:start`/`node botRunner.js` | Repo-confirmed only; deployment invocation unknown |
| Container | No Dockerfile/Compose config found | UNKNOWN |
| CI environment | No `.github/workflows` or other repository CI config found | UNKNOWN |
| Build environment | No build image/runner config found | UNKNOWN |
| Runtime environment | Startup scripts use Node, env vars, and SQLite path; host/OS/architecture not encoded | UNKNOWN |
| Confidence | Development target owner-confirmed; Production platform not selected | **CONFIRMED for Development / DEFERRED for Production** |

When a hosting platform is selected, its owner must provide:

1. Hosting provider.
2. Production OS.
3. CPU architecture (x64/arm64/other).
4. Production Node.js version.
5. Build environment/runner image.
6. Runtime environment/host image.
7. Whether Docker/container is used.
8. Where `npm install`/`npm ci` executes.

The controlled Development mainline upgrade is authorized. Production certification remains deferred until same-platform verification can be run.

## CURRENT

| Item | Result |
|---|---|
| Analysis host | Node v24.21.0, npm 11.19.0, Windows 10 x64 |
| Production Node/OS/architecture | **NOT ESTABLISHED**; defer same-platform certification until hosting selection |
| Previous sqlite3 / tar | 5.1.7 / 6.2.1 |
| Development baseline sqlite3 / tar | 6.0.1 / 7.5.22 |
| N-API metadata | `[3,6]`; loaded on host N-API 10 |
| Native SQLite library | Previous 3.44.2 → Development baseline 3.52.0 |
| Previous audit | 7 findings: 2 low, 4 high, 1 critical |
| Development baseline audit | Full and production audit: 0 findings |
| Production audit | NOT RUN; Production runtime not established |

## VERSION MATRIX

| Version | Evidence | Decision |
|---|---|---|
| sqlite3 5.x patch/minor | npm registry lists 5.1.7 as the latest 5.x; it declares tar `^6.1.11`, with no patched 6.x tar range | No safe non-breaking candidate found |
| sqlite3 6.0.0 | Registry returned E404; version not published | Not a candidate |
| sqlite3 6.0.1 | Latest stable; Node `>=20.17.0`; N-API `[3,6]`; tar `^7.5.10`; node-addon-api `^8.0.0`; optional node-gyp `12.x` | Installed and verified as the Development mainline baseline; Production compatibility deferred |
| Latest stable | sqlite3 6.0.1 (`latest` dist-tag) | Same as Development baseline |

Development mainline chain after clean install:

```text
mihu-bot (temporary sanitized copy)
└── sqlite3@6.0.1
    ├── tar@7.5.22
    ├── prebuild-install@7.1.3
    └── node-gyp@12.4.0 [optional]
        └── tar@7.5.22
```

No cacache/http-proxy-agent path remains below node-gyp. Development tree contains one sqlite3 and one deduped tar.

## SECURITY

- Previous baseline critical: **PRESENT** (`tar@6.2.1`).
- Development mainline full and production audit: **0 findings**.
- Vulnerable tar: **REMOVED from Development tree**; mainline resolves `tar@7.5.22`.
- Runtime reachability: tar is **NOT_RUNTIME_REACHABLE** from inspected app request/runtime imports.
- Install/build reachability: **YES** in previous 5.1.7 baseline via `sqlite3/deps/extract.js` and `node-gyp/lib/install.js`; these extract source/header archives.
- Development remediation: sqlite3 6's declared tar range resolves patched `tar@7.5.22`; the Development mainline now uses 6.0.1. Production certification remains deferred until hosting selection.
- Exploit prerequisites include attacker influence over a processed archive or compromised package/build source. This remains a supply-chain threat, not “no risk.”

## COMPATIBILITY

| Area | Previous baseline | Development baseline | Result / caveat |
|---|---|---|---|
| Node | Development v24.21.0 | Engine `>=20.17.0` | PASS on Development; Production runtime not established |
| N-API | Previous package metadata `[3,6]` | `[3,6]` | PASS by metadata; native binary loaded on host N-API 10 |
| Prebuilt | sqlite3 5.1.7 installed | v6 prebuild installed from npm cache: `napi-v6-win32-x64` | PASS for Windows x64. Production OS prebuild not applicable until host selected |
| Source build | Not needed on host | `node-gyp rebuild` fallback not run | UNKNOWN; verify in production-equivalent Linux image if applicable |
| Native SQLite library | 3.44.2 | 3.52.0 | Version changes; current behavior smoke passes, but operational query/performance review remains advisable |
| Foreign keys | Default off in both; enabling works | Default off; enabling/enforcement works | PASS in temp tests; app behavior unchanged |
| Journal mode | Default file mode is not explicitly changed by repo | Development core test observes same default semantics; repo does not set WAL | PASS for exercised defaults; no production WAL mode configured by app |
| Existing DB format | sqlite3 5.1.7 | v6 reads/writes 5-created DB; 5 reopens it. v6-created DB also read/written/reopened by 5 | PASS on synthetic DB both directions; no production DB certification |
| API behavior | Callback Database/Statement | Existing callback APIs used unchanged | Development full repo suite passes |
| Native build dependencies | node-addon-api 7.1.1; node-gyp 8.4.1 | node-addon-api 8.9.2; node-gyp 12.4.0 | Major toolchain changes; Windows prebuild avoids local source compile. Linux/source build remains unverified |

## REPO SQLITE API USAGE MAP

| File/module group | API used | Read/write | Sensitive areas | Upgrade result |
|---|---|---|---|---|
| `database.js` | singleton `new sqlite3.Database`; `run/get/all`; `serialize`; `prepare/finalize`; `PRAGMA`; DDL; BEGIN/COMMIT/ROLLBACK | Both | All schema/startup/commission/payout/PII migration | Development startup fresh/existing/rerun/failure tests pass |
| `utils/dbHelper.js` | Promise wrappers for `db.run`, `db.get`, `db.all` | Both | Shared by route/service layers | Development full suite passes callback wrappers |
| `utils/transactionGate.js` | application Promise serialization around connection transactions | Both coordination | Wallet/order/refund/payout/profile/commission | Development cross-process financial tests pass |
| `utils/orderService.js`, `utils/walletService.js`, `utils/walletHelper.js` | wrappers/direct run/get/all; BEGIN IMMEDIATE/COMMIT/ROLLBACK | Write | Order, wallet, refund, ledger, audit atomicity | Development order/wallet/refund tests pass |
| `services/payoutService.js`, `utils/payoutSchema.js` | run/get/all wrappers; active unique index; transactions | Write/read | Reserve, paid, rejected, batch and journal | Development payout/migration/cross-process tests pass |
| `routes/user.js`, `routes/system.js`, `routes/management/*`, `config/passport.js`, `commands/*`, `handlers/*` | direct callback `db.get/all/run` and shared wrappers | Both | Profile, commission, VIP, roles, auth, staff, wallet/orders | Development authenticated HTTP/import tests pass |
| `utils/reconciliationService.js`, `utils/walletMirrorMonitor.js`, `scripts/payrollEncryptionStatus.js` | separate `OPEN_READONLY` connection, SELECT, PRAGMA table metadata, close | Read-only | Forensic/mirror/PII count scans | Development reconciliation/scanner tests pass |
| Maintenance/import/test scripts | callback API, `exec`, prepared statements, serialize, close | Both | Seed/reset/migration fixtures | Not run against production |

No application source uses `db.each()` or `db.parallelize()`. No application code explicitly enables WAL or sets `foreign_keys`; only tests set busy timeout/foreign-key PRAGMA.

## BREAKING CHANGE MATRIX

| Area | Repo usage / Development baseline result | Breaking? | Required follow-up |
|---|---|---|---|
| Database/Statement callback API | Full 24-test Development suite passes | No observed break | Keep callback contracts |
| Prepared statements/bindings | Development core test passes | No observed break | Preserve finalize/error handling |
| Transaction/locking | Development Wallet/Order/Payout and cross-process suites pass; side-by-side 25 transactions/100 reads shows no busy errors | No observed Development regression | Production-host smoke still required after platform selection |
| Constraints/FK | Unique constraint and enabled FK violation tests pass; FK default remains off | No observed break | Do not silently change FK setting |
| PRAGMA | `foreign_keys`, `user_version`, `journal_mode` checks pass; same behavior observed | No observed break | Production PRAGMA/journal mode must be recorded |
| Native SQLite library | 3.44.2 → 3.52.0 | Native core changes | Review release notes/query plans/backup-restore before formal baseline update |
| Build tooling | node-gyp 8 → 12, node-addon-api 7 → 8 | Yes, major transitive changes | Verify Linux source build/CI toolchain |

## DEVELOPMENT BASELINE TEST RESULTS

- Clean mainline `npm ci`: **PASS** under Development Windows x64 / Node 24.21.0 with Discord/SMTP disabled and secrets removed. sqlite3 lifecycle installed a cached `napi-v6-win32-x64` prebuild; native module load passed. Lifecycle allowScripts warning was noted; install nevertheless completed.
- Mainline `npm audit` and `npm audit --omit=dev`: **0 findings**.
- Mainline tree: sqlite3 6.0.1, tar 7.5.22, node-gyp 12.4.0; no duplicate sqlite3/tar.
- Mainline repo suite after clean install: **24/24 PASS** (Wallet, Ledger, refunds, orders, payout, commission migration, encryption migration, failure injection, cross-process concurrency, audit, permissions, Studio, reconciliation).
- Mainline JS syntax: 106/106 PASS; EJS: 50/50 PASS.
- SQLite core test: module load, temp DB, CRUD, prepared statement, parameter binding, constraint, FK, PRAGMA, BEGIN/BEGIN IMMEDIATE, commit, rollback, concurrent writes, close/reopen: **PASS**.
- Existing DB compatibility: synthetic v5→v6 read/write→v5 reopen **PASS**, and synthetic v6→v5 read/write→v6 reopen **PASS**.
- Side-by-side smoke: 25 immediate transactions and 100 reads per version; concurrent two-connection writes had 0 busy errors for each. Timing is only a smoke, not a benchmark.
- External effects: test env disables Discord/SMTP/command registration; import tripwires pass. No production credentials were copied to candidate.

## LOCKFILE REVIEW

The mainline lock diff contains 6 added package entries, 66 removed entries, and 12 version changes. They are attributable to the sqlite3 6 parent/toolchain transition: sqlite3 5.1.7→6.0.1, tar 6.2.1→7.5.22, node-gyp 8.4.1→12.4.0, node-addon-api 7.1.1→8.9.2, and their install/build transitive graph. No other application direct dependency was changed by this upgrade; package/version entries in the main lockfile match the tested isolated candidate. Existing ExcelJS/uuid/script changes predate this upgrade. No duplicate sqlite3/tar exists.

## DEPLOYMENT / ROLLBACK

- Development baseline: Windows x64, Node 24.21.0; N-API v6 prebuilt path verified.
- Production/Staging OS, architecture, and Node: not applicable/not selected yet; Linux prebuilt/source-build is not claimed.
- No application code edits were required by the exercised API surface. When Production hosting is selected, rerun clean install/native binding/DB regression on that exact target before certification.
- Dependency-only rollback: restore sqlite3 5.1.7 and its pre-upgrade lockfile, then run `npm ci`; this dependency update made no DB schema/file-format changes. Production deployment/rollback planning remains deferred until a host is selected. Any future combined application/schema migration needs a separate rollback plan.

## DECISION

**Development baseline: VERIFIED. Production platform compatibility: `PENDING_PLATFORM_SELECTION`.**

Main development baseline now uses sqlite3 6.0.1/tar 7.5.22. Clean install, zero full/prod audit, native load, 24-test full suite, 106 JS syntax checks, 50 EJS compiles, SQLite core and bidirectional synthetic DB compatibility passed. This clears the Development dependency blocker only. Production certification is deferred until a future host is selected and tested on its exact OS/architecture/Node.

No Production DB, payout, PII row, credential, Discord/SMTP service, or historical financial record was changed or accessed. Rollback of the development dependency-only change is `sqlite3@5.1.7` plus the pre-upgrade lockfile; no database schema/format migration was run by the dependency upgrade.
