# Integration contract proposal v0.1

This is a proposal shared byte-for-byte between both handoff folders. These operations are NOT implemented or provider API names. Coordinate changes with the orchestration owner and propagate them to both teams. The domain behavior is transport-independent. JSON over authenticated HTTP is a recommended service transport, not a dependency on a language or framework.

## Relationship to commit 04cd7ce

C3 is the external agent → orchestration boundary. C4 is the orchestration → group-payment-service boundary. The earlier `docs/reap-wrapper-contract.ts` is a lower-level typed provider adapter used inside that service; it is not the MCP tool surface. HTTP between components does not require HTTP around each Reap wrapper method. No component may expose raw provider credentials or infer participant identity from model arguments.

The new participant-funded-before-checkout target is not fulfilled by the original external-card checkout followed by virtual-credit debits. Preserve the old adapter's completed-checkout debit precondition; implement any verified contribution/compensation flow as separate payment-service/provider operations with explicit authorization and recovery. Do not reinterpret a virtual posting as a transfer into the paying account. Funding route, custody, fees and wallet-backed checkout effects remain unverified until demonstrated for the team's project.

## C1: Identity and safe commands

User identity comes from an authenticated principal established outside model-supplied arguments. MCP forwards delegated identity in a backend-verifiable way. User tools never accept an arbitrary acting userId. Service-to-service authentication is separate from participant identity.

All mutations carry:
- commandId: caller-generated opaque idempotency key, reused on retry.
- expectedVersion: last observed group version for changes to an existing group.
- Domain arguments only. Orchestration resolves ownership and permissions.

A same-key/same-payload retry returns the original result. Same key with a changed payload returns IDEMPOTENCY_CONFLICT. Concurrent or stale mutations return VERSION_CONFLICT and current version. The adapter must reread and explain rather than silently broadening authorization.

State-changing commands return authoritative group version/status, own participant state, pending actions, and emitted event IDs. An accepted HTTP request is not a successful payment.

Common errors: UNAUTHENTICATED, FORBIDDEN, NOT_FOUND, VALIDATION_ERROR, VERSION_CONFLICT, IDEMPOTENCY_CONFLICT, GROUP_NOT_OPEN, MEMBERSHIP_LOCKED, CONSTRAINTS_NOT_MET, APPROVAL_STALE, QUOTE_EXPIRED, ITEM_UNAVAILABLE, PAYMENT_PENDING, PROVIDER_UNAVAILABLE. Return structured error codes and retryability. A timeout during a money operation requires status lookup, not a new payment.

## C2: Shared data

- IDs: opaque strings. Never derive identity or authorization from a display name.
- Merchant/group identities: merchantId and groupBuyId are internal domain IDs, mapped durably to the adapter's storeId and groupOrderId. Merchant names returned by product search are not globally unique provider IDs; unverified or ambiguous mappings cannot authorize a purchase.
- Execution mode: results and events distinguish LIVE, SANDBOX, SANDBOX_SIMULATED and LOCAL_MOCK. A sandbox merchant simulation does not prove a participant transfer or debit occurred.
- Money: {currency: "USD", minor: "1200"} means USD 12.00. Use canonical integer strings for minor units, matching the exported `Money` type in `docs/reap-wrapper-contract.ts`, and BigInt/decimal arithmetic internally; never floating-point money arithmetic. Token amounts remain exact decimal strings with explicit chain/token/decimals in the payment service. Conversion is not implicit.
- Time: RFC 3339 instants plus an IANA display timezone. Window: {startsAt, endsAt, timeZone}. Joining deadline is a separate instant.
- Collection point: {label, latitude, longitude, address}; expose only fields appropriate to the requesting user's role. Do not expose participants' search origins or funding details to one another.
- Variant: {merchantId, productId, variantId, title, attributes}.
- Constraints: {maxTotal, origin: {latitude, longitude}, maxDistanceMeters, availabilityWindow}.
- Participant line: {variantId, quantity}; all lines must belong to the buy's merchant.
- Authorization: immutable record identifying authenticated participant, permitted items/quantities, limits, collection details or constraints, and the action granted. A model cannot create unlimited authority by claiming consent.
- Order revision: changes when membership, quantities, allocation, price, or other financially relevant details change. Approval binds to its recorded revision and total. Superseded approval requests are marked obsolete, never applied to a different order. Accepting an unchanged price request changes group state/version but does not itself create a new financial order revision or invalidate other participants' approvals.

### Authorization and version compatibility

Keep `expectedVersion` for concurrency separate from `orderRevision` for financial terms. Neither substitutes for the Reap wrapper's quote revision/fingerprint. Orchestration stores the exact adapter-issued quote fingerprint and passes it back unchanged at checkout. A final payment snapshot binds participant authorizations to the current items, quantities, collection terms, fees, exact debit amounts and quote evidence.

The earlier wrapper workflow requires exact final participant approval; this handoff permits a previously recorded bounded grant to cover a final amount within its limits. Do not silently treat those as identical consent policies. A trusted application validator must establish that the actual final terms fall within each authenticated grant, or obtain fresh explicit approval. It must produce an auditable authorization reference and exact final amount; the model cannot perform this conversion by claiming consent. Until that validator is implemented, bounded grants cannot be used as a shortcut around exact-final-approval checks. An above-limit change always needs that participant's explicit response to the current request.

Each public `commandId` can initiate multiple provider operations. Persist distinct stable wrapper `operationId` and `idempotencyKey` values for each sub-operation and retain their mapping to the command/payment operation. Do not reuse one provider key across different participant requests or payloads. Wrapper quote revisions, purchaseAttemptId uniqueness and participant debit uniqueness remain additional protections, not replacements for group-version checks.

## C3: Orchestration operations exposed through MCP

Names below are proposed MCP tool names and equivalent domain operations. No MCP tool directly debits wallets or starts a second independent checkout.

| Tool | Inputs beyond command metadata | Result and enforcement |
| --- | --- | --- |
| search_catalog | query, optional merchantId, cursor | Merchant/product/variant identities and indicative prices, not guaranteed quotes |
| find_group_buys | selected variants/quantities, constraints | Up to three eligible merchant buys, distance/window, estimated own total, quote freshness, explanation |
| get_group_buy | groupBuyId | Role-filtered state, version, own allocation and pending actions |
| create_group_buy | merchantId, own lines/constraints, collection point/window, joining deadline, creation consent reference | Creates buy and organizer membership only after explicit opt-in recorded by trusted application flow |
| join_group_buy | groupBuyId, lines, constraints, authorization reference | Checks current state, exact variants, identity, constraints and authorization before adding caller |
| leave_group_buy | groupBuyId | Removes caller before collection lock and recalculates |
| close_group_buy | groupBuyId | Organizer only; stops joins and starts finalization, NOT a declaration that payment succeeded |
| cancel_group_buy | groupBuyId | Organizer only before collection; otherwise return locked/recovery status |
| respond_to_price_change | groupBuyId, approvalRequestId, decision: ACCEPT or REJECT | Caller must own current request; accept its exact displayed terms or remove participant on reject |
| get_my_updates | cursor, limit | Durable caller-scoped events and pending actions, nextCursor |
| get_payment_status | groupBuyId | Sanitized outcome and caller-authorized next actions, no provider secrets |

Read tools need no mutation metadata. For consent references, use backend-recorded grants or authenticated approval records. A user-facing confirmation screen or authenticated conversational channel can capture consent. A free-text claim by an agent is not proof of another person's authorization. The first target host's method of binding user consent must be implemented explicitly.

Minimum states exposed by orchestration:
- OPEN: new joins allowed.
- FINALIZING: closed to new joins, validating quote and participant responses. Leaves/rejections may still change the order before lock.
- COLLECTING: immutable authorized-order revision handed to payment service; participant contributions are not yet all confirmed.
- PAYMENT_ACTION_REQUIRED / PAYING: provider action or processing outstanding.
- RECOVERING: contributions/refunds or uncertain payment state unresolved.
- COMPLETED: payment service reports SUCCEEDED, with required participant funding and merchant success both confirmed. Merchant completion alone is insufficient; parcel delivery is a separate fact.
- FAILED / CANCELLED: no outstanding funds or actions requiring recovery.

An OPEN buy can contain pending price approvals after membership changes. A price approval request is not itself a group lifecycle state. A late join racing close must serialize on the backend.

## C4: Orchestration to payment service

Service operations, proposed names:

- searchMerchantProducts / getMerchantProduct: optional provider gateway supplying normalized catalog data to orchestration. Orchestration owns public catalog semantics and ranking.
- quoteGroupOrder(order): prices one merchant's exact variants/quantities, shipping/collection destination as applicable. Return quoteId, quoteRevision, quoteFingerprint, expiry, itemPricing evidence, nullable verified item-level amounts, shared fees/tax/discount breakdown, currency, availability, fulfillment estimate if available, and funding-fee estimates. Reap's reviewed base quote is aggregate-only: catalog prices must not be labeled final item prices. Missing merchant timing is unknown, not a promise.
- startGroupPayment(snapshot): accepts one authorized immutable revision. Returns paymentOperationId and current operation state. Atomically deduplicate by groupBuyId + orderRevision and request idempotency key. A new revision/key cannot bypass an existing unresolved or successful merchant attempt for the same buy; replacements require a definitively failed/expired attempt and explicit reauthorization.
- getGroupPayment(paymentOperationId): authoritative operation, per-participant collection/refund state, merchant status, and role-scoped next actions.
- requestRecovery(paymentOperationId, reason): idempotent cancellation/recovery request, not a guarantee of refund. Return current state and whether further action is required.

Snapshot fields:
{
  "schemaVersion": "1",
  "groupBuyId": "gb-demo",
  "orderRevision": 7,
  "merchantId": "merchant-demo",
  "quoteId": "quote-demo",
  "quoteRevision": 1,
  "quoteFingerprint": "<adapter-issued fingerprint>",
  "quoteExpiresAt": "<RFC3339>",
  "organizerId": "user-a",
  "lines": [
    {"participantId": "user-a", "variantId": "variant-a", "quantity": 1},
    {"participantId": "user-b", "variantId": "variant-b", "quantity": 1}
  ],
  "merchantTotal": {"currency": "USD", "minor": "2200"},
  "participantCharges": [
    {"participantId": "user-a", "merchantShare": {"currency": "USD", "minor": "1200"},
     "fundingFee": {"currency": "USD", "minor": "0"},
     "totalDebit": {"currency": "USD", "minor": "1200"}, "authorizationId": "auth-a"},
    {"participantId": "user-b", "merchantShare": {"currency": "USD", "minor": "1000"},
     "fundingFee": {"currency": "USD", "minor": "0"},
     "totalDebit": {"currency": "USD", "minor": "1000"}, "authorizationId": "auth-b"}
  ],
  "fulfillment": {"collectionPoint": "<structured point>", "collectionWindow": "<structured window>"}
}

Placeholders are illustrative, not ready-to-send JSON fixtures. Zero funding fees are an example, not an assumption about Reap.

Quote evidence must support the allocation before any participant collection. If exact per-item attribution cannot be established, finalization is blocked by default; an estimate-based allocation policy requires a separate explicit product decision and recorded participant consent. Preserve the tax-included flag and all fees/discounts; do not manufacture item-level prices to make the snapshot sum. Refreshing or selecting shipping can change the fingerprint even when the total stays equal, invalidating approvals tied to the old quote.

Payment resolves participant IDs to funding sources in its own secure records. All merchant shares sum exactly to merchantTotal. Total debits include disclosed funding fees and must match authenticated authorizations. Any changed fee/price requires reauthorization, not a silent larger debit.

Payment validates the snapshot, trusted caller and authorization records before collection. If it cannot validate an approval reference through an agreed service lookup or signed record, it must not charge. Expired quotes require refresh before irreversible work. If repricing occurs after contributions, pause/recover and return explicit action requirements, never increase charges unilaterally.

Operation states:
- ACCEPTED: durable request recorded.
- COLLECTING: participant contributions pending.
- ACTION_REQUIRED: a particular user must perform an action.
- PAYING: merchant checkout processing.
- SUCCEEDED: all required participant collections and merchant result confirmed.
- RECOVERING: partial collection or failed/unknown checkout requires reconciliation/refunds.
- FAILED: definitively unsuccessful with no unresolved participant funds.

Track participant collection and refund statuses separately. Timeouts or missing callbacks are unknown, not FAILED. Native atomic split checkout is not assumed. Do not release orchestration's membership lock while financial exposure remains.

`requestRecovery` is a group-workflow request, not a claim that Reap Agentic has merchant cancellation or refund endpoints. Distinguish returning collected participant contributions, compensating a known virtual posting, and refunding a merchant charge. Only invoke a verified operation for the relevant funding path; otherwise remain RECOVERING with a role-scoped RECOVERY_REVIEW action. Never issue refunds while a merchant outcome remains unknown.

### Provider adapter mapping and gaps

- Catalog: the service may use discoverMerchants/searchProducts/getProductDetails/resolveVariant. Discovery remains product-derived and partial, not a full merchant directory or geospatial search. Orchestration supplies configured country/currency and its own matching rules.
- Quotes: createQuote/getQuote/selectShippingOption supply normalized totals and fingerprints, not guaranteed line-item allocations or merchant delivery promises.
- Merchant payment: createEnrollment/getEnrollment/createCheckout/getCheckout supply one purchaser's hosted flow. The organizer is the designated approver under the new product rules only if the service verifies their authority over the actual funding source. Do not infer that a Reap user/account automatically has an eligible Agentic enrollment.
- Wallets: getWallet/listCards are diagnostics. debitWallet/getWalletDebit/retryWalletDebit implement the old post-checkout virtual-credit model, not participant collection before checkout. getOperation recovers one adapter mutation; it is not the aggregate group-payment status.
- Missing above the adapter: approved contribution collection, contribution recovery, immutable multi-participant payment operations, authenticated authorization lookup, durable status/events and background reconciliation. These require implementation and provider evidence; the existing wrapper interface alone does not provide them.

Reap-issued-card enrollment (`REAP_CARD`) and `BIN_SPONSOR` are marked coming soon by the reviewed create-enrollment endpoint despite setup-guide examples. Keep them unverified until Reap confirms project enablement and sandbox behavior. An external test-card checkout must not be presented as proof that participant wallets funded the merchant.

## C5: Events and next actions

Persist events before attempting delivery. Authenticate callbacks, deduplicate eventId, and track per-operation monotonic sequence. Retries can be duplicated/out of order. On a gap or disagreement, read authoritative status. An outbox plus retry worker is recommended. Broker choice is an implementation detail.

Envelope:
{schemaVersion, eventId, type, aggregateId, sequence, occurredAt, correlationId, payload}

Payment events: payment.status_changed (operation ID, order revision, public state, per-participant outcomes, next-action references). No credentials or sensitive provider payloads in events.

Domain events: participant.joined, participant.left, approval.required, approval.resolved, group.closed, group.cancelled, payment.action_required, group.completed, group.failed.

Next action: {actionId, kind, targetUserId, orderRevision, amount?, expiresAt?, secureActionRef}. Kinds include PRICE_APPROVAL, FUNDING_SETUP, CONTRIBUTION_APPROVAL, MERCHANT_APPROVAL, RECOVERY_REVIEW. Adapter returns only actions the caller may view. Reap hosted URLs should be fetched for the correct authorized user and not broadcast to a whole group.

The MCP client can fetch get_my_updates and current status after reconnect. Tool progress messages and connected-session notifications do not replace durable events or an offline notification channel. Core deadlines and payment polling run independently of MCP connections.

## C6: Integration sequence

1. Agree this proposal's names, authentication scheme, errors, and schemas across the three components. Publish the chosen OpenAPI or equivalent machine-readable contract before integration.
2. Build contract mocks that exercise success, pending approval, stale state, duplicate commands, and recovery. Label mock results.
3. Replace mocks with real services without changing group-buy business semantics.
4. Prove the multi-user scenarios in each folder's acceptance guidance. Record which checks use mocks and which reach provider sandbox.
