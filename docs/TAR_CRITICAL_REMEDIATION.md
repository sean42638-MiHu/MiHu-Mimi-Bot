# TAR Critical Remediation

Status: **CRITICAL REMOVED FROM DEVELOPMENT BASELINE; PRODUCTION PLATFORM CERTIFICATION DEFERRED**. Main Development now uses sqlite3 6.0.1/tar 7.5.22. No Production/Staging runtime exists yet.

## PRE-UPGRADE TAR DEPENDENCY CHAIN

```text
ROOT PROJECT: mihu-bot@2.0.0 [production]
└── sqlite3@5.1.7 [direct, production runtime package]
    ├── tar@6.2.1 [production dependency, install/build use]
    ├── prebuild-install@7.1.3 [production dependency, install-time]
    └── node-gyp@8.4.1 [optional dependency, build-time]
        ├── tar@6.2.1 [build-time]
        └── make-fetch-happen@9.1.0 [build-time]
            ├── cacache@15.3.0
            │   └── tar@6.2.1 [build-time]
            └── http-proxy-agent@4.0.1
                └── @tootallnate/once@1.1.2
```

Current Development chain:

```text
mihu-bot@2.0.0
└── sqlite3@6.0.1
    ├── tar@7.5.22
    └── node-gyp@12.4.0
        └── tar@7.5.22 (deduped)
```

Pre-upgrade `npm explain tar` confirmed three parent paths: direct from sqlite3 (`^6.1.11`), node-gyp (`^6.1.2`), and cacache (`^6.0.2`), resolving to tar 6.2.1. Development now resolves sqlite3 6.0.1 → tar 7.5.22 with node-gyp 12.4.0; both full and production audit are zero. Tar use remains install/build-time, not application request-time.

## Advisory Evidence

- Advisory: **GHSA-23hp-3jrh-7fpw** (`tar` / node-tar decompression/parse DoS via unlimited input; npm audit metadata CVSS 7.5, CWE-770).
- Severity: **Critical** in npm audit metadata.
- Affected installed package: `tar@6.2.1`.
- Vulnerable range for this critical finding: `<=7.5.18`.
- Fixed range: `>=7.5.19` for this critical issue; the installed 6.2.1 is also affected by separate tar advisories whose maximum vulnerable version is `<=7.5.20`. The consolidated safe floor for the current advisory set is `tar@7.5.21`.
- Other tar advisories include archive path traversal, symlink/hardlink traversal, archive parsing and denial-of-service conditions. See npm audit advisory metadata and [DEPENDENCY_SECURITY_REPORT.md](DEPENDENCY_SECURITY_REPORT.md).
- Exploit precondition: an attacker must influence an archive consumed by an affected extraction operation, or compromise the package/prebuild/header/archive source. Application HTTP handlers do not pass request data to tar. This lowers direct remote reachability but does not remove developer workstation, CI, build-server, registry, or production-install supply-chain risk.

## Runtime / Install / Build Reachability

| Operation | Classification | Evidence |
|---|---|---|
| Application HTTP/runtime requests | **NOT_RUNTIME_REACHABLE** from inspected module graph | `sqlite3/lib/sqlite3.js` imports its native binding; it does not import tar, node-gyp, or prebuild-install. |
| sqlite3 source native build | **BUILD_TIME_REACHABLE** | `sqlite3/deps/sqlite3.gyp` invokes `node ./extract.js`; `sqlite3/deps/extract.js` imports tar and extracts the bundled SQLite source archive. |
| node-gyp header setup | **INSTALL/BUILD_TIME_REACHABLE** | `node-gyp/lib/install.js` imports tar and unpacks Node headers fetched for a build. |
| prebuild install | **INSTALL_TIME** | sqlite3 lifecycle is `prebuild-install -r napi || node-gyp rebuild`; prebuild package/archive acquisition is part of installation. |
| Production install / CI / workstation | **SUPPLY-CHAIN RISK** | Lifecycle/build tools are present in the production dependency graph. A production image built with npm lifecycle scripts can exercise these paths. |

## Version / Compatibility Answers

- Pre-upgrade sqlite3: `5.1.7`; latest 5.x returned by npm registry: `5.1.7`.
- Pre-upgrade tar: `6.2.1`.
- Patched tar package inspected: `7.5.21`, Node engine `>=18`.
- Pre-upgrade sqlite3 parent range: tar `^6.1.11`; no patched tar 6.x version satisfies it. A `tar@7` override crosses the parent semver range and would affect sqlite3 extract, node-gyp, and cacache consumers; no force override was used.
- Latest stable sqlite3 returned by npm registry: `6.0.1`; latest 5.x is `5.1.7`.
- sqlite3 6.0.1 declares Node `>=20.17.0`, N-API versions `[3,6]`, `node-addon-api ^8.0.0`, `prebuild-install ^7.1.3`, tar `^7.5.10`, and optional node-gyp `12.x`. Current target is Node 24.21.0; engine/N-API metadata is encouraging but does not prove published prebuild availability on this exact platform, ABI behavior, or SQLite DB compatibility.
- sqlite3 v6 is a **major upgrade**. It changes native-addon/build dependencies. The SQLite file format may remain readable, but existing DB open/read/write, transaction semantics, migration behavior, and backup/restore must be proven before adoption.
- Non-breaking remediation: **none found** in the current sqlite3 5.x line. Current audit's aggregate fix is sqlite3 6.0.1. No parent patch/minor with patched tar was found.

## Development Baseline Upgrade

**Development upgrade verified; Production certification deferred.** sqlite3 6.0.1 was installed in a sanitized OS-temp candidate and then promoted to the Development mainline. No Production DB, secrets, payouts, or PII rows were used. Do not run `npm audit fix --force`, switch SQLite libraries, or infer a Production platform from the Windows development host.

### Post-upgrade tree

| Check | Result |
|---|---|
| Development sqlite3/tar | `6.0.1` / `7.5.22` (single version each) |
| Pre-upgrade Critical | PRESENT in sqlite3 5.1.7/tar 6.2.1 chain; resolved in Development |
| Development full/prod audit | **0 findings** |
| Dependency update | sqlite3 exact 5.1.7→6.0.1; lock changes attributable to sqlite3/node-gyp/tar chain |
| Other existing worktree changes | ExcelJS/uuid and project scripts predate this upgrade |
| Production package/migration | **NOT RUN** |

No non-breaking route existed in the pre-upgrade tree: sqlite3 5.1.7 was latest 5.x and tar `^6.1.11` could not accept patched tar 7. The Development Windows x64/Node 24 baseline now passes clean install, 24 tests, audits, and synthetic DB compatibility. Production compatibility remains **PENDING_PLATFORM_SELECTION**. Full evidence: [SQLITE3_MAJOR_UPGRADE_ASSESSMENT.md](SQLITE3_MAJOR_UPGRADE_ASSESSMENT.md).

The N-API v6 Windows x64 prebuilt installed from npm cache. When Production hosting is selected, verify its exact OS/architecture prebuilt or source-build path and backup/restore behavior. No Production DB was accessed or modified.

## Supply-Chain Minimum Controls

- Use the checked-in lockfile with `npm ci`; do not resolve floating dependency trees in a production build.
- Build from a trusted, reviewed CI image and registry; keep build runners ephemeral and restrict their permissions.
- Do not expose production DB credentials, encryption keys, Discord/SMTP secrets, or deployment credentials during dependency installation/native compilation.
- Promote the resulting reviewed artifact instead of running `npm install` on the production host where operationally possible.
- Scan lockfile and built artifact; retain provenance/SBOM and build logs with secret redaction.

The Development dependency Critical is **RESOLVED**. Production platform/install certification is **DEFERRED** until hosting is selected. `NOT_RUNTIME_REACHABLE` is not equivalent to `NO RISK`.
