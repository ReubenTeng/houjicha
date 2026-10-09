# Acceptance checks

Expected behavior comes from the agreed rules and labeled provisional defaults in product-context.md. Use orchestration fixtures or a labeled contract mock, not duplicate business logic inside MCP.

## T1: Multi-user approval cascade

Fixture: merchant M, one eligible collection point/window, same currency USD. Alice, Bob, and Cara each request an item costing 900 minor units ($9). Shared delivery is 600 ($6). Each initially authorizes at most 1150 ($11.50).

1. Three join: each total is 1100. No increased-price approval is needed.
2. Bob leaves before collection: Alice and Cara now owe 1200 each. Both receive approvals and payment remains blocked.
3. Alice accepts 1200. Cara rejects, which removes Cara.
4. Alice now owes 1500. Her prior 1200 acceptance is insufficient. A fresh approval is required, and the old request cannot be replayed against the new revision.
5. Alice explicitly accepts 1500. Close/finalize if not already closed, validate the current quote, and submit one immutable payment request through orchestration.
6. Payment service first returns pending, then success. MCP must not report completed before that success.

Pass: exact states, versions, own totals and pending actions are visible in structured tool results. No automatic higher authorization and no five-minute silent drop.

## T2: Authority and retries

- Bob cannot accept Alice's request, close her buy, or inspect her wallet actions by supplying her ID.
- Repeating one join with the same command ID creates one membership.
- Changing payload under that command ID returns conflict.
- Two concurrent close commands produce one finalized payment operation.
- A stale approval or version returns a conflict without spending.

## T3: Constraints and merchant matching

An item absent from the buy but belonging to the same merchant can be added. A different merchant, wrong variant, excessive distance, or incompatible window cannot be silently accepted. Creation requires separate opt-in.

## T4: Disconnect and recovery

Disconnect the MCP client before the deadline. Core finalization still runs. Reconnect and retrieve durable updates. Simulate a payment timeout: show pending/unknown status and do not create another operation. Partial collection failure shows recovery, not successful order or immediately reusable funds.

## T5: Demonstration artifacts

Deliver a script/test command with definitive output for T1-T4, plus one real MCP host session using the tools. Record tool inputs/results with identities anonymized and secrets removed. Label backend mocks and payment mocks clearly. If backend/provider access is missing, list those checks as unverified, not passed.
