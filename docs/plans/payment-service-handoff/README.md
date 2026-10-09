# Payment-service teammate handoff

## Scope

Build the payment service component for merchant-level group buys. Each participant must fund their own share. The service then completes one combined merchant purchase. Implement the supported provider flow, not merely internal cost allocations.

The entry point may be an external AI agent through MCP. Telegram and a hosted agent are optional and outside your component. Your service receives trusted requests from orchestration, never arbitrary payment instructions directly from the model.

Read product-context.md, glossary.md, and integration-contract.md before implementing. provider-research.md contains verified public capabilities and unresolved project-specific facts. acceptance-checks.md defines the evidence required.

## Copy-paste implementation prompt

```text
Build the payment-service component described in this folder.
Read product-context.md, integration-contract.md, provider-research.md,
and acceptance-checks.md first.

The contract is a proposal, not an existing API. Align request/status/
event schemas with the orchestration owner. Own participant funding,
collection, Reap/Kwal integration, merchant checkout, provider-required
approvals, status reconciliation, and refunds. Keep the interface
independent of MCP, Telegram, and any AI host.

Verify the actual team configuration and supported collection flow.
Do not infer split checkout from the existence of multiple wallets.
Do not replace participant debits with bookkeeping and call it charging.

Implement labeled contract mocks while provider access is unavailable.
Never fabricate provider success. Preserve immutable order revisions,
per-participant authorization and exact money amounts, durable
idempotency, and recovery for partial/unknown outcomes.

Raise only material scope, custody, payment authority, or irreversible
financial questions. Record reversible defaults. Explain needed
credentials and use a local secret manager or environment configuration,
not pasted secrets in conversation. Stay in sandbox. Confirm test chain,
token, destination and authorized amounts before moving test assets.

Deliver service code, provider adapter, schemas/OpenAPI, mock fixtures,
recovery/status worker, authenticated event delivery, run instructions,
and repeatable acceptance evidence. Separate provider-sandbox proof from
mock tests. Report unresolved provider limitations explicitly.
```

## Implementation order

- A1: Verify team setup: User-Funded versus Program-Funded, enabled endpoints, sandbox base URL/version, supported test asset and chain, and the reported approximate 300-unit allocation. Read balances before proposing allocation. Do not assume ordinary USDC and Reap RUSDC are interchangeable.
- A2: Establish the actual per-participant charging path. Confirm whether approved wallet contributions can fund one paying account/card. Native split tender is not documented. Resolve who controls signing keys and what consent authorizes collection. This custody choice is material, not an implicit backend default.
- A3: Agree the proposed contract with orchestration. Return a complete quote/fee breakdown before money moves. Payment owns provider/token mechanics, orchestration owns splitting group charges and collecting user approvals.
- A4: Implement quote and status reads, then idempotent collection/checkout with durable operation state. An external SDK/API call inside a database transaction is not atomic payment.
- A5: Implement partial failure, approval expiry, quote expiry after collection, process restart, webhook duplication, and uncertain merchant outcomes before calling the happy path complete.
- A6: Prove acceptance-checks.md and report which provider capabilities were actually observed.

## Financial boundaries

- B1: Every participant is mapped to a funding source using secure server-side records. Verify that each contribution is authorized for the specific snapshot and total debit including fees.
- B2: One group payment operation may include multiple transfers and one merchant checkout. Persist each sub-operation/provider ID and its idempotency key. Maintain deduplication beyond a provider's short retention window.
- B3: Merchant shares sum to the merchant quote. Participant debits also cover disclosed collection fees. Fees deducted from transfers must not leave the paying account short.
- B4: Obtain all required contributions before merchant checkout, unless a separately approved provider-native atomic flow replaces this sequence. No implicit credit or organizer subsidy.
- B5: On partial collection failure, do not place a reduced order. Recover collected amounts and report participant-level refund progress. A refund fee/loss cannot be silently assigned to participants. If fee policy is unresolved, return RECOVERY_REVIEW rather than claiming a full refund.
- B6: Never retry an unknown merchant outcome as a new purchase or refund funds while a purchase might still succeed. Reconcile the existing operation.
- B7: Changes after collection begins are not ordinary edits. Return explicit repricing/action/recovery state. Do not silently increase a debit or mutate the funded order.
- B8: Only declare SUCCEEDED when both participant funding and merchant success are confirmed according to the documented sandbox behavior. A mock or simulated merchant receipt alone does not prove wallet debits.
- B9: Record refund completion separately from initiating a refund. Do not report terminal failure while participant funds remain unresolved.

## User actions and events

Return typed next actions with target participant/organizer, revision, expiry, and a secure reference. Some setup or collection flows may require individual wallet signatures. Route those to the appropriate participant. Route a required combined merchant approval to the authorized organizer.

Persist status and events even when no MCP client is connected. Use authenticated events plus status lookup for reconciliation. Provider callbacks may be duplicated or absent. Poll where official callbacks are unavailable.

Secrets, private signing material and raw card details stay inside secure provider integrations. Client-visible results contain only opaque IDs, approved display metadata, safe actions and sanitized errors.

## Suggested skills

No local skills are required. If your agent already offers them:
- domain-modeling: keep collection, merchant checkout, refund, and approval distinct.
- code-review: review authorization, precision, retry safety and recovery.
- diagnosing-bugs: investigate reproduced sandbox or reconciliation failures.

Use official provider documentation and SDKs rather than reproducing crypto/signing primitives. The supplied procedures are sufficient if no Skill tool exists.

## Out of scope

Group matching, membership storage, user conversations, MCP tools, Telegram, production rollout, and a custom escrow contract. If the provider requires a materially different product or new financial component, expose that as a blocker instead of silently broadening implementation.
