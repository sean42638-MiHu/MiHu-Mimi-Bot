# Test Side Effect Incident Report

Execution time: 2026-09-26; exact time UNKNOWN (terminal timestamp unavailable)
Entry point: `require('./index')` during HTTP smoke test

## Observed and Potential Effects

| Check | Status | Evidence |
|---|---|---|
| `bot.js` loaded | YES | `index.js` imports `./bot`; `routes/system.js` also imported it |
| Discord login attempted | YES | `bot.js` called `client.login(token)` at module load; a token was present |
| Discord REST called | UNKNOWN | REST registration is invoked from the ClientReady callback; no result was captured |
| Guild command registration called | UNKNOWN | Registration follows successful Gateway readiness; no result was captured |
| SMTP transport initialized | YES | Importing the email route imported `emailService.js`, which created a Nodemailer transport |
| SMTP message sent | NO | The smoke requests did not invoke the email-send endpoint |
| Production DB touched | YES | Importing `database.js` opened the fixed project SQLite DB and ran startup schema/data initialization |
| Production Guild touched | UNKNOWN | No safe pre-incident snapshot or captured registration result exists |
| Secrets printed to tool output | YES | A prior credential search output included matching `.env` lines; secret values are intentionally omitted here |

No attempt will be made to query Discord or SMTP using the existing credentials to reconstruct the incident. Guild/global command state and Gateway logs remain UNKNOWN until reviewed through an already-authorized, read-only operational channel.

## Credential Assessment

- Local `.env` contains suspected-valid Discord bot token, Discord OAuth client secret, and SMTP password. Values are not reproduced.
- Secret-bearing locations: `.env:14` Discord bot token; `.env:12` Discord OAuth client secret; `.env:33` SMTP password.
- `.env` is not tracked by Git; repository history scan found no credential-like assignments and no `.env` commits.
- Because credential-bearing lines appeared in prior tool output, rotate the Discord bot token, OAuth client secret, and SMTP password: **ROTATION REQUIRED**.
- Other credential types and error-stack/artifact exposure: NOT VERIFIED.

## Containment

- Do not run the bot, command registration, SMTP delivery, or live external integration tests until isolation and credential rotation are complete.
- Treat production Guild command state as UNKNOWN. Do not run registration to inspect it.
- Do not automatically modify or reconcile financial production data as part of incident response.

## Isolation Remediation

- `app.js` builds the Express application without listening or starting Discord.
- `index.js` loads configuration and starts the web server only when run directly; database initialization is explicit.
- `bot.js` defines the bot client without login or command registration. `botRunner.js` requires `DISCORD_ENABLED=true` before login.
- Discord command registration and clearing require separate explicit flags and are unavailable by default in tests.
- Email transport creation is lazy; sending requires `SMTP_ENABLED=true`. Tests require an injected fake transport.
- `NODE_ENV=test` requires a database path under the OS temporary directory and rejects the project database.
- `npm test` runs import tripwires for HTTP listen, Discord login/REST mutation, SMTP transport/send, and database migration.
- Verification: import-safety and reconciliation regressions PASS (2/2); 82 JavaScript syntax checks PASS; 49 EJS templates compile PASS.
