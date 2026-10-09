# Group-buy orchestration core

## Status and contract

The transport-independent TypeScript contract is src/orchestration/contract.ts. The implementation is src/orchestration/application.ts. No MCP, Telegram, model or provider SDK is imported into the core.

This implements the rules and provisional defaults in docs/plans/orchestration-handoff/. It does not implement the unrelated ShipFund PRD or the old checkout-then-debit flow.

The handoff folder was already untracked when implementation began. It and teammates' documentation remain unchanged.

## Integration

Construct Orchestration with a Store, CatalogPort, GroupPaymentPort, AuthorizationPort and Clock. SqliteStore is the real single-instance persistence adapter. Node >=22.13 is required for node:sqlite. The SQLite API is experimental in some supported Node versions. Keep the database outside a publicly served directory and use host filesystem permissions for private records.

An authentication adapter constructs ActorContext separately from untrusted operation inputs. The userId in ActorContext is not self-authenticating. Never deserialize it directly from MCP arguments or an unsigned HTTP header. No target host identity adapter is supplied here.

AuthorizationPort resolves previously recorded grants from a trusted user confirmation flow. HOST consent covers the merchant, exact basket, constraints, collection arrangement and joining deadline. JOIN consent covers the merchant, exact basket, constraints and arrangement. DemoAuthorization is only a fixture. A grant string or an agent's assertion is insufficient without a backend record owned by the authenticated actor.

Operation mapping:

| Proposed tool | Application operation |
| --- | --- |
| search_catalog | searchCatalog |
| find_group_buys | findGroupBuys |
| get_group_buy | getGroupBuy |
| create_group_buy | execute, operation=create |
| join_group_buy | execute, operation=join |
| leave_group_buy | execute, operation=leave |
| close_group_buy | execute, operation=close |
| cancel_group_buy | execute, operation=cancel |
| respond_to_price_change | execute, operation=respond |
| get_my_updates | getMyUpdates |
| get_payment_status | getPaymentStatus |

Mutation inputs carry commandId and expectedVersion. Successful same-key/same-payload retries return the original role-filtered response, including after restart. Changed payloads conflict. Version comparison, state, command result and durable events commit together. Errors are DomainError instances with a safe code, retryable flag and currentVersion where relevant. Failed commands have no committed effect or cached result. Adapters must not infer that a returned stale original response is current state.

getMyUpdates uses a monotonically increasing database cursor, returns only caller-scoped events and lists current pending actions separately. Cursor advancement may skip other users' events. An outsider can query public discovery details but receives neither another participant's origin nor a collection street address nor funding actions.

## Payment integration requirements

GroupPaymentPort must durably deduplicate submissionId and groupBuyId/orderRevision before money movement. getGroupPayment must support lookup by submissionId even when startGroupPayment's response was lost. A null result means no operation was found, not a timeout. It must not hide an accepted operation behind eventually consistent lookup and start another checkout.

Payment receives the immutable authorized snapshot, owns participant collection, merchant checkout and recovery, and must validate authorization records before charging. getPaymentAuthorization is a service-only lookup for an authenticated payment adapter, not a user tool. No HTTP endpoint for this lookup is exposed. Grant references and accepted approval IDs resolve to the locked participant's exact total and snapshot. Payment authority cannot be inferred from a user-supplied boolean.

A service status reports each participant's collection/refund outcome, merchant status, unresolved funds, sequence and private next actions. The core only declares COMPLETED on an authoritative successful merchant result and successful participant collections. Failed or unknown refunds keep membership locked. FAILED does not automatically reopen the buy or trigger another attempt.

Call reconcile(submissionId) from an authenticated payment callback adapter. It ignores callback payload claims and reads authoritative status, so duplicates, gaps and out-of-order callbacks cannot directly overwrite state. The periodic worker also reconciles without callbacks.

Missing shipping inputs, unavailable items, missing verified line attribution or inconsistent quote amounts block finalization. The port must reject quotes requiring a shipping address unless the organizer supplied valid fulfillment details. Map coordinates are not invented shipping addresses.

## Decisions log

- D1: Preserve TypeScript/Vitest and the existing Telegram starter. No HTTP adapter is added because in-process integration is sufficient for the current core scope.
- D2: Use exact nonnegative integer strings, at most 18 decimal digits, at serialized seams and bigint for allocation. The shared numeric-minor-unit proposal is not silently accepted. MCP/payment teammates must explicitly map or adopt this contract.
- D3: Use a collect-first high-level payment port. Do not call the legacy ReapWrapper checkout/debit operations from the lifecycle.
- D4: Inject trusted identity and consent. Demo grants and payment are LOCAL_MOCK. Real deployment must supply authenticated delegated identity and consent capture.
- D5: Use built-in Node SQLite, WAL, a versioned schema and aggregate JSON. The aggregate persists scheduled deadlines and payment intent. Versioned writes serialize competing workers. Payment-service deduplication permits safe redundant dispatch calls without a separate queue, broker or job lease. There is no exactly-once network-delivery claim.
- D6: Keep the confirmed collection arrangement immutable. No editing operation exists. arrangementFixed records whether another participant ever joined, even after departure.
- D7: Require verified participant-line totals for all final allocations. Aggregate-only evidence remains disabled rather than inventing attribution for even a simple basket. Shared delivery is the only shared charge. The payment adapter must incorporate item-specific taxes/discounts in verified lines and reject unsupported attribution.
- D8: Expired quote refresh creates a new financial revision and supersedes old approvals. A response to an unchanged live request increments group version but not financial revision. Pending approvals have no response timeout.
- D9: Persisted intents are dispatched with stable identity. A lost response keeps the snapshot locked. An expired intent not yet dispatched can return to finalization. If dispatch might have happened, reconcile/recover using that identity rather than issuing a new snapshot.
- D10: No provider credentials, real-money actions, production deployment, MCP SDK or Telegram adaptation are part of this change.
- D11: Atomically bind each consent grant to one user/group. Reusing a HOST or JOIN grant for another group cannot authorize another purchase. Cancelled buys do not release consumed grants. A fresh explicit consent record is required. The binding survives departures and restarts.
- D12: Idempotency keys are scoped by authenticated caller and operation, as implementation-plan S3 specifies. Reusing a key for a different operation is a different namespace. This clarifies the proposal's less-specific same-key wording.
- D13: Domain event sequences are separate from group versions so multiple events from one command have distinct increasing sequences. Callback reconciliation always reads authoritative service status rather than trusting an event payload.

## Running the worker

Import runWorker from src/orchestration/worker.ts and start it in the backend with an AbortSignal and an error reporter. It periodically scans durable aggregate deadlines and pending payment work. Client disconnects do not stop it. On restart, instantiate the same Store and ports and restart the loop. One tick is bounded by the injected ports' request timeouts, which real adapters must enforce.

SQLite is a single-host demo choice, not a multi-host database. Quote/network calls occur outside database transactions. Writes use expected versions. Competing workers may request the same read or dispatch operation, but the payment service must expose one financial operation for its stable identity.

## Repeatable evidence

Run:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run docs:check
npm run orchestration:demo
```

The demo starts four independent OS processes against one temporary SQLite database. Alice, Bob and Cara initially owe 1100 each. Bob leaves, Alice accepts 1200 and Cara rejects. Alice's new 1500 approval supersedes the old one. The demo restarts before dispatch and after a fault-injected lost acknowledgment, replays the recorded command, reconciles late success and asserts one immutable payment operation. It prints sanitized versions, revisions, totals, approval IDs, operation IDs and missed events. The temporary database is removed afterward.

Acceptance tests are src/orchestration/application.test.ts. Expected outcomes come from the handoff's named T1-T7 fixtures, not from implementation internals.

## Verification results

Two verification rounds were used. Round 1 passed typecheck, build, wrapper-reference checks and the four-process demo, but failed two acceptance tests. The organizer-window fixture was corrected and unresolved FAILED payment statuses were allowed to advance through recovery. Independent review also identified grant reuse, a stale-worker error race, a duplicate-command lookup race and automatic-cancellation approvals. These were fixed and covered before round 2. The suggested cross-operation key change was not adopted because S3 explicitly scopes keys by operation.

Round 2 ran this exact command successfully with exit code 0:

```sh
npm run typecheck && npm test && npm run build && npm run docs:check && npm run orchestration:demo && node dist/orchestration/demo-cli.js && git diff --check
```

Recorded output:

```text
Test Files  4 passed (4)
Tests       32 passed (32)
Internal interface reference is current: 20 functions, all signatures covered.
PASS: 3 actors, approval cascade, 4 process lifetimes, one immutable payment operation, late success, durable updates.
```

Both source and compiled demonstrations passed. The 32 tests include 22 orchestration tests and 10 unchanged Telegram tests. SQLite emitted its experimental-feature warning. No provider call or money movement occurred.

npm ci and npm audit also reported three existing dev-dependency vulnerabilities: one moderate and two critical, involving Vitest, @vitest/mocker and tinypool. Dependency versions were not changed. A major Vitest upgrade is separate follow-up work, not silently included in this implementation.

## Limitations

- L1: Core persistence and rules are tested locally. Provider sandbox, real participant funding, merchant checkout and refunds are not verified.
- L2: MCP transport and the first host's backend-verifiable delegated identity/consent implementation are absent. Do not expose demo actors as deployment authentication.
- L3: GroupPaymentPort is not an adapter for the older ReapWrapper. Payment teammates must supply collect-first behavior, trusted authorization validation, verified line pricing, idempotent recovery and authoritative status lookup.
- L4: Currency/fee serialization and operation identity names require teammate agreement. Historical handoff files remain proposals and are not rewritten.
- L5: No shipment tracking, physical collection completion, substitutions, partial checkout, complex shared discounts, FX or automatic retry purchases are added.
