# SMTP Staging Checklist

Status: **EXTERNAL_ENV_REQUIRED**. No production SMTP credential was read, printed, rotated, or used. No email was sent during this closure phase.

## Required Human Inputs

- [ ] Provider-approved sandbox/test SMTP endpoint.
- [ ] Dedicated test mailbox with no production recipients/forwarding.
- [ ] Newly rotated staging credential provisioned through the secret provider.
- [ ] Staging callback/base URL and sender identity approved.
- [ ] Confirm `SMTP_ENABLED=true` only in the isolated staging runtime.

Never put credential values in this checklist, command history, logs, or repository.

## Verification

- [ ] Verification email arrives in the dedicated mailbox.
- [ ] Password/security email flows, if enabled in this application release, use only the test mailbox.
- [ ] Email-change verification succeeds; expired/used codes are rejected.
- [ ] Invalid recipient/provider rejection is handled without exposing addresses or credentials.
- [ ] Provider unavailable/timeout returns controlled application response.
- [ ] Retry behavior is bounded and does not duplicate verification state.
- [ ] Logs and audit records contain no SMTP password, auth headers, codes, or full sensitive profile values.
- [ ] External-call tests/tripwires remain enabled outside the explicit staging test.
- [ ] Staging results, timestamps, and operator are recorded without secret values.

## Production Gate

`BLOCKED_EXTERNAL_ENV` until sandbox tests pass. Production credential rotation remains a manual provider action; this checklist does not authorize sending a production smoke email.
