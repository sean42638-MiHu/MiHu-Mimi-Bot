# Persistent Web sessions

Production Web now stores sessions in a separate SQLite file. It uses the existing
sqlite3 dependency; package.json and package-lock.json do not change. Development
and test runtimes retain MemoryStore so existing isolated login fixtures keep
working.

The default is `sessions.sqlite` beside `DATABASE_PATH`, which means
`/var/lib/mihu/sessions.sqlite` for this deployment. An optional absolute
`SESSION_DATABASE_PATH` can override it. Storage must be outside the repository
and cannot alias the business database, including through a hard link. The Web
service already permits writes to `/var/lib/mihu`; no unit or environment changes
are required for the default. The session file is restricted to mode 0600.

Web waits for both business DB readiness and session storage initialization before
listening. A storage error never silently switches Production to MemoryStore.
Expired rows are removed at startup and hourly; reads enforce expiry immediately.
The store implements touch without rewriting authentication data or resurrecting
a session deleted by logout. Shutdown closes the store after HTTP requests finish.

## Effect on existing users

The first rollout cannot recover sessions held in the previous process's memory.
Users need to log in again once. Afterward, unexpired sessions survive Web
restarts as long as the session database and SESSION_SECRET remain unchanged.
Business DB data, VIP settings, balances, roles, commissions and services are
not migrated, imported or restored by this update. The Bot needs no restart.

## Local application

Save `mihu-session-fix.bundle` to `D:\mihu-bot-mimi` and run in local PowerShell:

```powershell
cd D:\mihu-bot-mimi
git bundle verify .\mihu-session-fix.bundle
if ($LASTEXITCODE -ne 0) { throw "Bundle verification failed" }
git fetch .\mihu-session-fix.bundle fix/persistent-sessions:refs/heads/fix/persistent-sessions
if ($LASTEXITCODE -ne 0) { throw "Bundle import failed" }
git switch main
if ($LASTEXITCODE -ne 0) { throw "Branch switch failed" }
git merge --ff-only fix/persistent-sessions
if ($LASTEXITCODE -ne 0) { throw "Fast-forward failed" }
git status --short
```

Only the fix commit is included; untracked JSON exports and bundle files remain
untracked. Do not stage them with `git add .`.

After reviewing the update, `git push origin main` from the local computer publishes
it. The VPS's read-only GitHub key can fetch this commit.

## VPS deployment

Before running, confirm the repository is clean and still at the expected
previous deployment `af7f4155f570eb68020ff7042d8f2e5cedc49518`. If the deployment
has changed, compare changes before proceeding.

From the VPS terminal, first fetch and inspect the incoming change:

```bash
cd /opt/mihu/app
git status --short
git fetch origin
git --no-pager diff --stat HEAD origin/main
```

Deploy only the prepared Session fix. Record the current SHA as the code rollback
target, fast-forward the checkout, and run the four focused test files. No npm
install is necessary because the lockfile and dependencies are unchanged.

```bash
git merge --ff-only origin/main
node --test tests/sqlite-session-store.test.js tests/login-auth-transition.test.js tests/production-safety-foundation.test.js tests/vps-deployment-contract.test.js
```

Check each command succeeds before the next. Then restart Web only and verify:

```bash
sudo systemctl restart mihu-web
sudo systemctl --no-pager --full status mihu-web
curl --fail --silent --show-error http://127.0.0.1:3000/healthz
sudo journalctl -u mihu-web --since "5 minutes ago" --no-pager
sudo stat -c '%U:%G %a %n' /var/lib/mihu/sessions.sqlite
```

Expected: active Web, `ok` health response, no new MemoryStore warning, and
`mihu:mihu 600` for the session file. Sign in again, check the wallet and VIP page,
then restart Web once more and refresh the signed-in page to verify persistence.
The Bot and Nginx can remain running throughout.

If Web does not start, inspect its log and the configured session directory's
permissions. A code rollback may return to the recorded previous commit and
restart Web. Do not restore or overwrite the business database, and do not rerun
migration, role bootstrap or settings import commands for this change.

## Validation on the prepared patch

Node.js v24.19.0: focused suite 21/21 passed. Full `npm test`: 176 tests total,
175 passed, 1 skipped, 0 failures. Tests use isolated temporary databases and
mock authentication, never the deployed database or a real Discord account.
Deployment behavior still requires verification on the VPS after installation.
