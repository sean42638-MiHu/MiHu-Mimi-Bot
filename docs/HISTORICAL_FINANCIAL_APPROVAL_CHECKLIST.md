# Historical Financial Approval Checklist

Status: **MANUAL_FINANCIAL_APPROVAL_REQUIRED**. This is an approval worksheet only. No repair command or ledger suggestion is implied. Do not edit production balances, create historical Ledger rows, or link Order 61 without original external evidence and explicit approval.

## Required Evidence Per Record

| Record ID | Difference type | Current DB evidence | Original external evidence available? | Bank/payment evidence | Legacy-system evidence | Proposed classification | Proposed repair | Balance impact | Ledger impact | Manual approver / date | Execution status |
|---|---|---|---|---|---|---|---|---:|---|---|---|
| WALLET-DIFF-A | Non-zero wallet without Ledger | See latest read-only report / forensic report; no identifier/value copied here | NOT PROVIDED | NOT PROVIDED | NOT PROVIDED | INSUFFICIENT_EVIDENCE until reviewed | None | 0 | 0 |  | NOT APPROVED |
| WALLET-DIFF-B | Non-zero wallet without Ledger | See latest read-only report / forensic report; no identifier/value copied here | NOT PROVIDED | NOT PROVIDED | NOT PROVIDED | INSUFFICIENT_EVIDENCE until reviewed | None | 0 | 0 |  | NOT APPROVED |
| ORDER-53 | Completed order missing payment Ledger | Forensic report only | NOT PROVIDED | NOT PROVIDED | NOT PROVIDED | INSUFFICIENT_EVIDENCE | None | 0 | 0 |  | NOT APPROVED |
| ORDER-54 | Completed order missing payment Ledger | Forensic report only | NOT PROVIDED | NOT PROVIDED | NOT PROVIDED | INSUFFICIENT_EVIDENCE | None | 0 | 0 |  | NOT APPROVED |
| ORDER-55 | Completed order missing payment Ledger | Forensic report only | NOT PROVIDED | NOT PROVIDED | NOT PROVIDED | INSUFFICIENT_EVIDENCE | None | 0 | 0 |  | NOT APPROVED |
| ORDER-56 | Completed order missing payment Ledger | Forensic report only | NOT PROVIDED | NOT PROVIDED | NOT PROVIDED | INSUFFICIENT_EVIDENCE | None | 0 | 0 |  | NOT APPROVED |
| ORDER-57 | Completed order missing payment Ledger | Forensic report only | NOT PROVIDED | NOT PROVIDED | NOT PROVIDED | INSUFFICIENT_EVIDENCE | None | 0 | 0 |  | NOT APPROVED |
| ORDER-58 | Completed order missing payment Ledger | Forensic report only | NOT PROVIDED | NOT PROVIDED | NOT PROVIDED | INSUFFICIENT_EVIDENCE | None | 0 | 0 |  | NOT APPROVED |
| ORDER-61 | Unlinked payment candidate | Candidate only; reference is unresolved | NOT PROVIDED | NOT PROVIDED | NOT PROVIDED | UNRESOLVED_CANDIDATE | None; do not auto-link | 0 | 0 |  | NOT APPROVED |

## Approval / Execution Gate

- [ ] Primary evidence is attached to an access-controlled finance case, not this document.
- [ ] Finance classifies each record and documents source provenance.
- [ ] Proposed changes are reviewed independently by a second approver.
- [ ] Balance/Ledger/order/audit effects and idempotency are specified before execution.
- [ ] Dry run is reviewed on a sanitized copy.
- [ ] A separately authorized operator executes the approved repair and captures before/after evidence.
- [ ] Read-only reconciliation is rerun and no unrelated differences are modified.

If primary evidence is unavailable, retain `INSUFFICIENT_EVIDENCE` and make **no repair**. Order 61 remains unresolved; amount/time resemblance is not authorization to create a Ledger link.
