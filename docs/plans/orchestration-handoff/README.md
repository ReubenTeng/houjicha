# Our handoff: group-buy orchestration

## Goal

Implement the group-buy core behind the teammates' MCP and payment components. It must work without a built-in agent or Telegram, and retain state when every client disconnects.

This folder is self-contained for product rules and implementation planning. Repository source is still needed for implementation. The current baseline is commit 9ab628b on main. No application code was changed while preparing this handoff.

## Read in order

1. product-context.md: agreed rules, provisional defaults, and rejected alternatives.
2. repository-status.md: existing code, source conflicts, and decisions for this handoff.
3. integration-contract.md: proposed user operations, payment operations, state and event shapes.
4. implementation-plan.md: staged work and completion criteria.
5. acceptance-checks.md: required evidence.
6. glossary.md: shared terms.

The product context is derived from the same snapshot as both teammate handoffs. The integration contract is copied unchanged. The contract remains a proposal, not an implemented API. repository-status.md explicitly qualifies mismatches found in the current repo.

## Scope we own

- O1: Merchant-level buys, individual baskets, collection arrangements, deadlines and durable lifecycle.
- O2: Exact-variant catalog queries through a provider-neutral dependency, eligibility filtering and ranked group discovery.
- O3: Authenticated user authorization, cost allocation, revised-price accept/reject requests, and order locking.
- O4: Idempotent application commands, concurrency control, durable events and client-readable updates.
- O5: Submitting one authorized payment snapshot and consuming authoritative payment status.

MCP teammate owns the tool adapter and client integration. Payment teammate owns wallet setup, participant collection, merchant checkout, provider actions, reconciliation and refunds. We own neither provider secrets nor payment arithmetic inside Reap.

## Copy-paste continuation prompt

```text
Implement the orchestration core described by this folder.
Read README.md, product-context.md, repository-status.md,
integration-contract.md, implementation-plan.md, acceptance-checks.md,
and glossary.md before changing code.

Inspect the current checkout and instructions. The handoff baseline is
9ab628b, not a guarantee that the checkout is unchanged. Preserve
teammates' work and the existing TypeScript/Vitest stack.

Build transport-independent application operations. No MCP SDK,
Telegram SDK, provider client, or model belongs in domain logic.
Use typed ports and labeled fakes while teammate integrations are
unavailable. Payment collection and recovery stay in the payment
service component, even if it is injected in the same process.

Follow the agreed rules and labeled provisional defaults. Do not use
the unrelated ShipFund PRD or the older checkout-then-debit flow as
authority for this product. Surface the contract conflicts described
in repository-status.md. Do not silently implement two money models.

Proceed through reversible choices. Keep a decisions log. Ask only
about material scope, authority/custody, or irreversible behavior.
Do not pause the core work while waiting for provider credentials.

Use existing checks and explicit acceptance fixtures. Verify a
three-person approval cascade, concurrent duplicate commands, restart
recovery and unknown payment outcomes. Label fakes and unavailable
provider seams. Commit coherent verified changes without pushing.
```

## Suggested skills

No private skill library or Skill tool is required. If available, use domain-modeling for vocabulary, codebase-design for module boundaries, code-review for invariant and authorization review, and diagnosing-bugs for reproduced failures.

For supervision, use this standalone rule: inspect existing evidence first, choose reversible defaults, and ask only when an answer changes product scope, payment authority, custody, or irreversible behavior. State a concrete example, recommendation and consequence. Do not restart a long design interview.

## First implementation action

Inspect the current repo and align the payment boundary with the teammate. Start domain behavior and contract fakes immediately. Treat unresolved real payment integration as disabled, not as a reason to delay membership, approvals, persistence or API work.
