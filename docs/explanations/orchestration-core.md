# Group-buy orchestration core

## Status and contract

The transport-independent TypeScript contract is src/orchestration/contract.ts. The implementation is src/orchestration/application.ts. No MCP, Telegram, model or provider SDK is imported into the core.

This implements the rules and provisional defaults in docs/plans/orchestration-handoff/. It does not implement the unrelated ShipFund PRD or the old checkout-then-debit flow.

The handoff folder was already untracked when implementation began. It and teammates' documentation remain unchanged.

## Integration

Construct Orchestration with a Store, CatalogPort, GroupPaymentPort, AuthorizationPort and Clock. PostgresStore is the production persistence adapter for Supabase PostgreSQL. Use createSupabaseStore from src/orchestration/supabase.ts to load the existing backend connection fields. All application queries and service authorization lookups now return promises and must be awaited. SQLite remains only in explicitly labeled local fixtures for portable offline tests and fake payment state. Node >=22.13 is needed by those fixtures, not by the PostgreSQL adapter.

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
- D5: Use Supabase PostgreSQL with JSONB aggregates and transactional commands, consent bindings and events. Short commits use a schema-scoped transaction advisory lock across backend instances. This preserves version checks and commit-ordered update cursors. Payment-service deduplication permits redundant dispatch calls without claiming exactly-once network delivery. Quote and provider calls remain outside database transactions.
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

Supabase PostgreSQL allows multiple backend instances against the same database. Writes use expected versions and serialize short commit transactions. This intentionally favors correctness over high write throughput. Competing workers may request the same read or dispatch operation, but the payment service must expose one financial operation for its stable identity.

## Supabase setup

1. Copy .env.example to .env only if .env does not already exist. Never overwrite existing secrets.
2. In Supabase, open Connect and select a direct database connection or session pooler. Copy the PostgreSQL host, port, username and password into SUPABASE_URL, SUPABASE_PORT, SUPABASE_USER and SUPABASE_PASSWORD. SUPABASE_URL is retained for compatibility, but must contain a host, not the project HTTPS API URL. SUPABASE_DATABASE defaults to postgres.
3. If the connection needs Supabase's database CA, download its PEM file and set SUPABASE_SSL_CA_FILE to its path. TLS certificate verification is always enabled.
4. Run npm run db:setup once against the intended empty project. It applies supabase/schema.sql, a fresh schema with no SQLite import, data migration, drop or truncate. Tables remain in the backend-only orchestration schema, with PUBLIC privileges revoked and RLS enabled. Do not add this schema to Supabase's exposed Data API schemas. Use an owner/backend database role, never browser credentials.
5. Construct the store with createSupabaseStore and inject it into Orchestration alongside trusted catalog, authorization and payment ports. The Telegram starter is not automatically wired to the core by this change.

The schema setup is explicit, not run when constructing the store or starting tests. Local PostgreSQL tests create unique disposable schemas in a separately supplied ORCHESTRATION_TEST_DATABASE_URL. They do not read .env or contact the hosted Supabase project. Default tests and demos remain portable offline SQLite fixtures and label that mode.

For PostgreSQL acceptance and four-process proof:

```sh
export ORCHESTRATION_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/postgres
npm test
npm run orchestration:demo
```

Use a disposable PostgreSQL database you control. The suite creates and removes only its generated test schemas. Without this variable, PostgreSQL cases are explicitly skipped rather than reported as verified.

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

The demo starts four independent OS processes against one database: a generated PostgreSQL schema when ORCHESTRATION_TEST_DATABASE_URL is supplied, or a temporary SQLite fixture otherwise. Alice, Bob and Cara initially owe 1100 each. Bob leaves, Alice accepts 1200 and Cara rejects. Alice's new 1500 approval supersedes the old one. The demo restarts before dispatch and after a fault-injected lost acknowledgment, replays the recorded command, reconciles late success and asserts one immutable payment operation. It prints sanitized versions, revisions, totals, approval IDs, operation IDs and missed events. The temporary schema or fixture is removed afterward.

Acceptance tests are src/orchestration/application.test.ts. Expected outcomes come from the handoff's named T1-T7 fixtures, not from implementation internals.

## Supabase persistence verification

Verified against an isolated local PostgreSQL 14 server, without reading production .env credentials or contacting hosted Supabase. The complete check chain passed with exit code 0:

```sh
export ORCHESTRATION_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/postgres
npm run typecheck && npm test && npm run build && npm run docs:check && npm run orchestration:demo && node dist/orchestration/demo-cli.js && git diff --check
```

Recorded results:

```text
Test Files  6 passed (6)
Tests       68 passed (68)
LOCAL_MOCK payment. PostgreSQL core persistence. No provider calls or fund movement.
PASS: 3 actors, approval cascade, 4 process lifetimes, one immutable payment operation, late success, durable updates.
```

The same 23 lifecycle/atomicity cases ran against PostgreSQL and the offline fixture, for 46 acceptance tests. Seven Supabase configuration checks and 15 existing Telegram/demo-account tests also passed. Source and compiled PostgreSQL restart demonstrations both passed. Atomicity checks include rollback of state, recorded commands and earlier events when a later event insert fails. The race fixture accepts either legal winner rather than assuming synchronous call order.

Supabase configuration uses verified TLS and preserves the existing field names. Hosted connectivity and certificate acceptance are not claimed from a local non-TLS PostgreSQL test. The fresh schema was initialized only in disposable local schemas, not deployed remotely. A TypeScript callback requiring async/Promise.all was corrected during the initial preflight check.

## Original SQLite baseline verification

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

- L1: PostgreSQL persistence and rules are verified against a disposable local server. Hosted Supabase connectivity, credentials and TLS remain unverified because no remote database was modified. Provider sandbox, real funding, merchant checkout and refunds are also unverified.
- L2: MCP transport and the first host's backend-verifiable delegated identity/consent implementation are absent. Do not expose demo actors as deployment authentication.
- L3: GroupPaymentPort is not an adapter for the older ReapWrapper. Payment teammates must supply collect-first behavior, trusted authorization validation, verified line pricing, idempotent recovery and authoritative status lookup.
- L4: Currency/fee serialization and operation identity names require teammate agreement. Historical handoff files remain proposals and are not rewritten.
- L5: No shipment tracking, physical collection completion, substitutions, partial checkout, complex shared discounts, FX or automatic retry purchases are added.
