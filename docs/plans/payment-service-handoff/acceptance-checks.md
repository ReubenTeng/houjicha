# Payment acceptance checks

These tests derive from the requirement to charge each participant, preserve their authorization, and make one merchant order, plus the provisional all-or-nothing/recovery defaults. No real merchant purchase is expected in sandbox.

## T1: Multi-participant success

Use three isolated test participants. Submit a fixed merchant quote and authorized contribution allocations with known fees. Show:
- Each participant's recorded starting balance and funding-source mapping.
- Their exact authorized debit and confirmed collection result.
- Funding reaching the paying account, if the selected flow pools contributions.
- One merchant checkout for the immutable order.
- Final participant balances and merchant outcome.

Check merchant shares equal quote total and fee handling reconciles. If the provider simulates merchant checkout without changing funding balances, state precisely which movements are real testnet transfers and which are simulated. Never label an allocation-only record as a participant debit.

## T2: Duplicate request and restart

Send startGroupPayment twice with the same key and snapshot. Restart the service after a provider operation is accepted but before its response is persisted. Retry/reconcile. There must be one logical operation and no duplicate contribution or merchant purchase. A changed snapshot under the original key must fail.

## T3: Partial collection failure

Alice and Bob's contributions succeed; Cara's fails definitively. No merchant order is placed. Recover Alice and Bob's contributions, show refund IDs and confirmed results, or an explicit unresolved recovery state. Do not report FAILED with money outstanding.

## T4: Unknown checkout outcome

Simulate a timeout after merchant submission. Deliver a late success event, duplicate it, then deliver an older event. No new checkout, premature refund, or regression from success to an older pending state occurs. Status lookup remains authoritative.

## T5: Changed quote or fee

Present an expired quote or a total debit above the authorized amount. No unauthorized collection happens. If changed pricing is discovered after some funds arrive, return explicit action/recovery state and keep the order locked. Never fund the gap implicitly.

## T6: Approval and identity

A participant cannot approve another's contribution or the organizer's merchant approval by changing an ID. Hosted approval returning to a URL does not prove payment succeeded. Read provider status. Missing, denied, or expired approval must not be treated as accepted.

## T7: Recovery failure

Cause a refund to remain pending or fail. State remains RECOVERING, affected participants remain visible, retries are idempotent, and no second merchant order starts. Any unrecoverable fee is disclosed rather than reported as a full refund.

## Required proof

Deliver exact test commands, sanitized output, and provider/testnet references where applicable. Run mock fault tests for T2-T7 and a sandbox end-to-end scenario reaching participant funding and merchant checkout for T1. Report unavailable sandbox seams as unverified. This handoff itself does not claim those tests have run.
