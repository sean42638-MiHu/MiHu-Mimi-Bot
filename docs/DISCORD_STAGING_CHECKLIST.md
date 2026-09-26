# Discord Staging Checklist

Status: **EXTERNAL_ENV_REQUIRED**. No production Bot token, OAuth credential, or Production Guild was used. No command registration or role mutation was performed.

## Required Human Inputs

- [ ] Dedicated test bot with newly rotated staging token.
- [ ] Test OAuth application/client secret and callback URL.
- [ ] Development/Test Guild, test channels, and test roles.
- [ ] Test users for authorized and denied permission cases.
- [ ] Confirm all staging IDs/credentials are supplied through environment/secret provider.

Do not register/clear commands or modify roles in a Production Guild during staging.

## Verification

- [ ] Slash command registration targets only the Test Guild.
- [ ] `/register` and `/bind` work only for the test identities and expected state.
- [ ] Admin-only commands allow the authorized test role and deny a normal member.
- [ ] Role/identity sync is constrained to the Test Guild and test accounts.
- [ ] Missing permission, invalid identity, rate limit, provider failure, and restart behavior are handled.
- [ ] No Bot token, OAuth secret, authorization header, or full bank data appears in logs/audits.
- [ ] Test requests are verified against Guild ID before any write.
- [ ] Capture test results and operator/time without credential values.

## Production Gate

`BLOCKED_EXTERNAL_ENV` until a test Guild and rotated staging credentials are available and the full checklist passes. This checklist does not authorize Production Guild registration.
