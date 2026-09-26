# Credential Rotation Checklist

Status: **MANUAL_SECURITY_ACTION_REQUIRED**. This document intentionally contains no credential values. Rotation must be performed by the credential owner in each provider console and secret provider.

| Provider credential | Provider revocation complete? | New value in secret provider? | Repository/log scan clean? | Service restarted? | Old value rejected? | Staging verified? | Production verified? | Operator / time / ticket |
|---|---|---|---|---|---|---|---|---|
| Discord Bot token | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |  |
| Discord OAuth client secret | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |  |
| SMTP credential | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |  |
| Payroll encryption key | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |  |

## Rules

- Never paste values into this file, tickets, shell command history, or chat.
- Update the secret provider first; restart only the intended environment.
- Verify old credentials are revoked/rejected and the new credential works in staging.
- Payroll key rotation is **not currently implemented**: do not replace the current key until versioned-key support and [PII_KEY_ROTATION_RUNBOOK.md](PII_KEY_ROTATION_RUNBOOK.md) implementation gates are complete.
- Keep per-provider timestamps, operator, provider receipt, and secret version identifiers only.
