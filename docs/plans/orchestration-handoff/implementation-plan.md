# Orchestration implementation plan

This is a plan, not code already implemented. Keep public tool operations aligned with integration-contract.md and apply the qualifications in repository-status.md.

## S1: Establish the seams

Define typed application operations for the C3 tool surface, taking a trusted ActorContext separately from untrusted inputs. Define CatalogPort, GroupPaymentPort, persistence, and Clock dependencies. Provider catalog access can be implemented by the payment component without moving matching into it.

Use one application module initially. Internal imports must not require grammY, an MCP SDK, a model API or a live Reap client. Keep src/telegram/ unchanged unless an explicit integration task needs it.

Done when contract fakes can invoke create, discover, join, leave, close, cancel, approval response and status operations without starting Telegram or accessing the network.

## S2: Implement domain rules and deterministic allocation

Represent:
- D1: Group buy, merchant reference, organizer, collection point/window, joining deadline, lifecycle, group version and financial revision.
- D2: Participant basket with exact variants, quantities, constraints, active membership and immutable authorization records.
- D3: Quote snapshot with expiry, exact attribution evidence, currency, shared charges and final allocations.
- D4: Approval requests bound to participant, revision and displayed amount, with pending/accepted/rejected/obsolete states.
- D5: Payment attempt reference, immutable submission snapshot, latest authoritative status, and unresolved financial exposure.

Persist whether another participant has EVER joined. Collection details do not become editable again merely because that person leaves.

Reject cross-merchant items and unauthorized actors. Filter matching candidates by distance, time, exact items and spending constraints before ranking. Expose estimates as estimates.

Allocate each participant's items and equally split shared delivery with stable ID-based remainder assignment. Preserve exact sums. Unsupported fee/discount attribution or unavailable items block finalization.

Recalculate after joins, departures, rejections and quote changes. Expire obsolete requests. Acceptance of an unchanged request does not itself change the financial revision. Previously authorized terms may still permit a refreshed quote, but a response to an obsolete request cannot authorize a different revision.

Done when the explicit approval-cascade and matching fixtures pass as domain tests.

## S3: Add durable commands and concurrency

Use the repository's persistence choice if one appears before implementation. Otherwise a small transactional SQLite store is a provisional single-instance demo default, not a requirement for all deployments. Select a maintained Node-compatible driver, version migrations, and isolate storage behind the application boundary.

Persist group state, memberships, authorizations, quote/approval records, command results, payment attempts, events, and scheduled work. Use one transaction for a command's state change, idempotency record and outbox event.

Scope command keys by trusted caller and operation. Same key/body returns the recorded result, changed body conflicts. Compare expectedVersion inside the write transaction. Serialize join versus close and approval versus departure. Payment submission has a durable unique identity per authorized financial revision.

Never hold a database transaction open around a provider network call. Persist intended work first, dispatch using the same operation identity, then reconcile the result.

Done when duplicate and concurrent commands survive process restart without duplicate membership or payment requests.

## S4: Implement finalization and background work

A joining deadline or organizer close stops new joins. FINALIZING can still need quote refreshes, departures and approvals before collection starts. Closing is not payment success.

Validate current quote, availability, item attribution, allocations and every authorization. Atomically lock the order and persist exactly one payment submission job before dispatching its immutable snapshot. A leave racing this transition either commits first and changes the revision, or is rejected as locked.

Workers run independently of MCP/Telegram connections. Claim due jobs safely, recover interrupted claims, and retry only with stable operation identity. Repeated deadline jobs do not resubmit payment.

Pending price approvals have no fixed timeout. Quote expiry creates a refresh requirement. If feasibility is genuinely lost before collection, cancel with a reason. Do not infer a guaranteed merchant delivery time from a sandbox collection window.

Done when a fake clock and restarted worker process deadlines, quote expiry and approval blocking without any connected client.

## S5: Integrate payment status and recovery

Consume the high-level payment port, initially fake. Deduplicate status events and reject stale per-operation sequences. Query authoritative status on gaps or uncertainty. Payment owns provider polling and money recovery. Our worker must not independently repeat Reap calls.

Keep membership locked throughout COLLECTING, PAYING and RECOVERING. A network timeout is unknown, never definitive failure. On partial collection or purchase failure, request the service's idempotent recovery operation as appropriate and show unresolved exposure until it confirms resolution.

No new purchase attempt or reopening while prior financial effects remain unresolved. After definitive failure with no outstanding funds, withdrawal may be enabled again. Do not automatically reopen joining or start another purchase. Those are separate lifecycle decisions.

COMPLETED means the merchant order/payment workflow succeeded, not that goods arrived. Do not add shipment tracking or physical collection completion to the MVP just because older docs mention it.

Done when the partial-collection, unknown-outcome, late-success and recovery-failure fixtures pass.

## S6: Expose application operations and durable updates

Provide role-filtered queries and durable get_my_updates cursor semantics. Include own totals, quote freshness, pending actions and safe payment state, not other people's funding details or original location.

Build a thin HTTP adapter only if needed for the MCP teammate's deployment. Generate/validate the chosen schema from the agreed types and publish errors and authentication requirements. Direct in-process calls are equally valid for the core.

Keep the MCP team's SDK/server code and Telegram's conversational flow outside this task. Define how verified delegated identity reaches ActorContext before a multi-user demo. A caller-supplied user ID or ordinary boolean is not authenticated consent.

Done when a contract client can exercise the C3 operations and retrieve missed events after reconnect.

## S7: Verify and commit incrementally

Use the acceptance fixtures, existing npm test and npm run typecheck checks. Run npm run build for the executable integration. If wrapper docs/types change in an authorized implementation step, run npm run docs:check and regenerate only through the documented script.

Use at most two verification rounds: verify, triage and fix, then repeat if needed. Report remaining failures or fixes not reverified. Include an executable multi-user demonstration with assertions and sanitized output, not only screenshots or an LLM narrative.

Commit each coherent verified implementation increment, only staging our files. Do not push unless asked. This handoff authorizes no production deployment or real-money operation.
