# Dependency Security Report

Current Development baseline audit: `npm audit` and `npm audit --omit=dev` on 2026-09-27 both report **0 findings** with sqlite3 6.0.1/tar 7.5.22. The 7-finding table below records the **pre-upgrade** sqlite3 5.1.7 tree (2 low, 4 high, 1 critical). No `npm audit fix --force` was used. Production audit/platform certification is deferred because no Production runtime is established. Upgrade evidence: [SQLITE3_MAJOR_UPGRADE_ASSESSMENT.md](SQLITE3_MAJOR_UPGRADE_ASSESSMENT.md).

## Pre-Upgrade Dependency Security Matrix

| Package | Direct / transitive | Pre-upgrade severity / affected range | Pre-upgrade | Current Development version | Runtime reachable? | Install/build / Production reachability |
|---|---|---|---|---|---|---|
| `sqlite3` | Direct | High; 5.0.0-5.1.7 via `node-gyp`/`tar` | 5.1.7 | 6.0.1 | Runtime native binding; install script also builds/loads binding | Development verified on Windows x64/Node 24; Production OS not selected |
| `tar` | Transitive (`sqlite3`; `node-gyp`; `cacache`) | Critical GHSA-23hp-3jrh-7fpw (CVSS 7.5/CWE-770; <=7.5.18), other advisories through <=7.5.20 | 6.2.1 | 7.5.22 | Not app request/runtime reachable; called by extraction tools | Pre-upgrade install/build reachable; current Development chain patched; Production certification deferred |
| `node-gyp` | Transitive / optional build dependency | High; <=10.3.1 | 8.4.1 | 12.4.0 | Not imported by app runtime | Build/install path; current dev chain audit clean |
| `make-fetch-happen` | Transitive (`node-gyp`) | High; 7.1.1-14.0.0 | 9.1.0 | Removed from Development tree | Not imported by app runtime | Pre-upgrade build/install path |
| `cacache` | Transitive (`make-fetch-happen`) | High; 14.0.0-18.0.4 | 15.3.0 | Removed from Development tree | Not imported by app runtime | Pre-upgrade build/install path |
| `http-proxy-agent` | Transitive (`make-fetch-happen`) | Low; affected 4.0.1 | 4.0.1 | Removed from Development tree | Not imported by app runtime | Pre-upgrade build/install path |
| `@tootallnate/once` | Transitive (`http-proxy-agent`) | Low; <2.0.1 | 1.1.2 | Removed from Development tree | Not imported by app runtime | Pre-upgrade build/install path |
| `uuid` | Transitive (`exceljs`) | Previously moderate; <11.1.1 | 11.1.1 | 11.1.1 | XLSX generation runtime; fixed | Current Development audit clean; HTTP XLSX test passes |

## sqlite3 / tar Reachability Evidence

- Before the Development upgrade, `sqlite3@5.1.7` declared `prebuild-install` and `tar`; its install script was `prebuild-install -r napi || node-gyp rebuild`.
- The pre-upgrade source-build path used `sqlite3/deps/sqlite3.gyp` → `deps/extract.js`, which imported tar to extract SQLite source; `node-gyp/lib/install.js` imported tar to unpack Node headers. These are install/build call sites, not the application's post-install query path.
- Current Development host: Node `v24.21.0`, Windows x64. Production host/runtime does not exist yet and remains unselected.
- `sqlite3/lib/sqlite3.js` loads `sqlite3-binding.js` and native bindings; the inspected runtime entry does not import `tar`, `node-gyp`, or `prebuild-install`.
- Pre-upgrade classification: **NOT_RUNTIME_REACHABLE** from inspected app requests, but **INSTALL/BUILD_TIME_REACHABLE** and a supply-chain risk.
- Development `npm ls sqlite3 tar node-gyp --all` now resolves sqlite3 6.0.1, tar 7.5.22, node-gyp 12.4.0; tar Critical is absent from both full and production audits.
- sqlite3 6.0.1 declares Node `>=20.17.0`, N-API `[3,6]`, `node-addon-api` 8.x, and optional node-gyp 12.x. Windows x64 prebuilt/load is verified; Production Linux/other platform is not applicable until a host is selected.
- `tests/sqlite-regression.test.js` passes the current sqlite3 6.0.1 development baseline. Synthetic file compatibility in both directions with 5.1.7 also passes.

The Development main tree is now sqlite3 6.0.1 → tar 7.5.22, with full and production audits at zero. The main package/lockfile change was limited to the sqlite3 direct version and its transitive chain; existing ExcelJS/uuid changes were retained. Production platform certification remains deferred until hosting is selected.

## Remediation Plan

1. Development Critical remediation is complete and verified; keep using `npm ci` and the committed lockfile.
2. When the Production hosting platform is selected, verify Node/OS/architecture and prebuild/source-build path on that exact target.
3. Run sanitized backup/restore and the full startup/financial/concurrency suite in same-platform staging before Production deployment.
4. Until those deployment gates pass, Production remains NOT READY even though the Development dependency tree is clean.
