# GroupCart: orchestration ↔ Reap wrapper API

Contract proposal v0.1 · Documentation checked 9 October 2026

**Swagger:** run `npm run docs:serve` and open `http://127.0.0.1:8080/docs`.
The [OpenAPI 3.1 specification](./reap-wrapper.openapi.json) is generated from
the TypeScript contract with `npm run docs:generate`; `npm run docs:check`
validates it. This documentation preview does not implement payment endpoints.

This document defines the boundary between two engineers. Engineer A owns the Telegram agent and order orchestration. Engineer B owns a Reap adapter that exposes the operations below. Names under `/internal/reap/v1` and all wrapper types are **our proposed interface**, not Reap endpoints. The companion [TypeScript contract](./reap-wrapper-contract.ts) defines the payloads.

Source workflow: `/Users/reuben/Documents/groupcart.excalidraw`. The drawing describes separate baskets from one store, a shared cutoff, one merchant order, wallet reconciliation, and collection from the organiser. It supersedes the older single-product assumptions in `prd.md` for this contract. The drawing is product input, not evidence of provider capabilities.

**Implementation status:** documentation and schema review only. No authenticated Reap requests, merchant purchases, or wallet mutations were performed. Documented support does not establish enablement for our project, merchant, country, currency, or card.

## 1. The boundary to agree first

**Engineer A — orchestration** owns Telegram identity/authentication, conversation, location and distance matching, open-order discovery, organiser selection, announcement, individual baskets, cutoff scheduling, cost allocation, participant approvals, local wallet reservations, order state, receipts, arrival confirmation and collection notifications. A decides whether a purchase is allowed.

**Engineer B — Reap wrapper** owns provider configuration and credentials, user/account/enrollment mappings, catalog calls, variant resolution, merchant eligibility configuration, quote retrieval, shipping repricing, hosted card enrollment, checkout submission/status, eligible virtual-asset debits, provider operation records, safe retries, balance reads and provider error translation. B validates the command and faithfully reports what Reap did.

Neither component makes an LLM responsible for money arithmetic or successful-payment decisions. B does not choose participants, divide delivery charges, infer consent, or send Telegram messages. A never calls Reap directly.

Recommended deployment: a typed module inside the same backend initially; use the HTTP routes below if the engineers run separate services. This avoids requiring another deployment just to establish ownership.

## 2. What Reap can and cannot supply

### Wallet value and card readiness are different checks

Reap account balance exposes assets, liabilities and available balance in the program billing currency. Under External authorization, its available-balance field is **not** the user's spendable balance; the platform ledger is authoritative. Our MVP adapter supports Reap balance-based spending only for a verified compatible configuration. [Account balance](https://docs.reap.global/api-reference/accounts/get-account-balance)

Per-asset reads distinguish crypto, fiat and virtual assets. A total account valuation does not mean every component can be debited through the virtual-posting API. Only the configured virtual asset is eligible for `debitWallet`. [Account assets](https://docs.reap.global/api-reference/accounts/get-account-assets)

Issued-card status comes from the Cards API. Agentic checkout readiness comes from an enrollment. An external card's bank balance or remaining credit is not supplied by enrollment metadata; return `null` for that information. An active enrollment permits attempting checkout, not guaranteeing payment. [Card details](https://docs.reap.global/api-reference/cards/get-card), [Enrollment setup](https://docs.reap.global/agentic-payments/setup)

### Merchant and product discovery

The documented discovery API searches **products within merchant catalogs**. The reviewed Agentic endpoint inventory has no independent merchant-directory, nearby-store, complete-catalog-download or store-opening-hours operation. `discoverMerchants` below is therefore derived from product search results, optionally enriched by our configured supported-store registry. It must disclose partial coverage. [Product search](https://docs.reap.global/api-reference/agentic/search-products), [Documentation index](https://docs.reap.global/llms.txt)

The schema supports `merchantPreference: {mode: "ONLY", merchantName: "…"}` as well as `PREFER`. Use `ONLY` once a group has selected its store. Search pagination accepts 1–50 results. Merchant names are not documented as globally unique merchant IDs; our `storeId` is an internal registry key. Verify fulfillment identity for the selected integration instead of merging sellers by display name. [Reap OpenAPI schema](https://docs.reap.global/api-reference/openapi.json)

FairPrice, Gardenia, Singapore delivery coverage and SGD pricing are examples from the concept, **not verified integrations**. Merchant coverage needs confirmation with Reap. [Merchant coverage FAQ](https://docs.reap.global/agentic-payments/faq)

### Merchant purchase versus participant payment

Agentic checkout purchases using one enrollment. It does not accept a participant roster or split tender across participant wallets. We propose one designated purchaser, whose hosted approval covers the combined merchant charge. Participant wallet consent is an independent GroupCart record. [Agentic overview](https://docs.reap.global/agentic-payments/overview)

Virtual assets are program-managed balances available for Program-Funded projects with Managed authorization. They are not a mechanism that transfers cash to an external-card purchaser. Production reimbursement/backing must be designed separately; the proposed demo uses explicitly labelled sandbox credits. [Virtual assets overview](https://docs.reap.global/virtual-assets/overview)

For this **external-card purchaser + separate participant credits** model, the proposed debit maps to `WITHDRAWAL`. Reap `SETTLEMENT` also reduces that same account's card debt, so it is not a synonym for settling a group order. Do not substitute it unless the money model changes and that account actually carries the relevant debt. [Create posting](https://docs.reap.global/api-reference/virtual-asset-postings/create-posting)

## 3. MVP assumptions and unresolved decisions

These are proposed implementation defaults, not product decisions already approved:

1. **Checkout owner:** support Reap-managed checkout with a human completing its hosted approval. This is distinct from an organiser manually placing an order on the merchant site. If manual checkout is chosen, A owns the handoff/evidence flow; B must not manufacture a Reap checkout result.
2. **Wallet model:** sandbox, Program-Funded + Managed, one enabled virtual asset valued at a fixed 1:1 rate to the same billing/order currency. No FX, top-ups or external transfers. Accounts are provisioned before the demo. B must verify these conditions before enabling wallet debits.
3. **Reservations:** A owns local holds. They do not reserve funds inside Reap and cannot prevent unrelated card spending. The demo must isolate participant balances from other writers/spending. Production needs an enforceable funds-reservation model before guaranteeing collection after purchase.
4. **Delivery split:** equal per participant, independent of item count, with deterministic remainder allocation. This needs team agreement. Each buyer otherwise bears their own basket cost. Taxes, fees and discounts need an explicit allocation policy too.
5. **Item price evidence:** the documented quote returns aggregate item subtotal and total breakdown, without checkout line prices. Exact heterogeneous-basket allocation remains a provider/merchant integration question. Default to blocking purchase if exact item attribution cannot be established; an explicitly approved proportional-estimate policy is a separate product choice.
6. **Delivery status:** organiser/merchant evidence supplies delivery and arrival updates. Checkout completion means order placed, not parcel delivered. No merchant-shipment tracking endpoint was found in the reviewed Agentic API. Reap's card-shipment endpoints track physical payment cards, not groceries.

## 4. Shared conventions

- Internal HTTP base: `/internal/reap/v1`; authenticated backend calls only. Use a dedicated service credential, never the Reap API key as the internal credential. Bind calls to the configured project/environment and verified user mappings.
- Every method returns `Result<T>` from the companion types. An unavailable or unknown field is `null`, never a fabricated zero, `false`, or empty success.
- Money is `{currency, minor}` where `minor` is an integer **string**, such as `{"currency":"SGD","minor":"625"}`. Use decimal/integer arithmetic; never floating-point addition for cost splits. All currencies in one quote must agree. Preserve provider decimal values in the private audit record.
- Reap money objects use numerical amounts in the documented examples; B converts currency units into our minor-unit representation. Virtual-asset quantities are decimal strings in asset units and use a separate `units` type. Verify conversion against live sandbox responses, including fractional amounts; fail on unsupported precision or currency.
- IDs are opaque. `storeId`, `groupOrderId`, `participantId`, `operationId`, `purchaseAttemptId`, `allocationId`, quote `revision`, and `fingerprint` are ours. `productId`, `variantId`, `quoteId`, `checkoutId`, `enrollmentId`, account IDs and posting IDs originate with Reap.
- Timestamps are RFC 3339 UTC. `observedAt` means when B read the provider, not a promise of ongoing freshness. Nullable provider timestamps remain nullable.
- Query pagination uses an opaque cursor bound to the original query/store/country/currency. Do not reuse it with changed filters. An empty page with a next cursor is not end-of-results.
- Mutations require a caller-generated `operationId` and `Idempotency-Key`. Persist both before dispatch. A retry uses the identical body and identifiers. Store mappings and outcomes durably, independently of Reap's cache.
- HTTP encoding: IDs shown in route placeholders go in the path; pagination goes in GET query parameters. POST inputs use JSON objects with the same property names as the types. `getProductDetails` uses `{productIds}` and `resolveVariant` uses `{productId, optionIds}`. Send `operationId` as `X-Operation-Id` and `idempotencyKey` as `Idempotency-Key`; they form `MutationContext` inside B. Body fields that also identify path resources must agree or be rejected. GET operations have no JSON body.
- Runtime validation is required; TypeScript declarations alone do not enforce business constraints.

## 5. API operations

The method names and exact input/output types are in `reap-wrapper-contract.ts`. B implements them; A consumes them and may build fixtures from the same types. All routes in this section are internal.

### 5.1 `getCapabilities` — GET `/capabilities`

Returns configuration, check time, feature evidence and unresolved reasons. Feature states are `VERIFIED`, `DISABLED`, or `UNVERIFIED`. `VERIFIED` means demonstrated for this environment/configuration, not merely described in documentation. Initially all untested features remain `UNVERIFIED`.

Required feature keys: agentic checkout, external enrollment, product search, virtual-asset debit, external checkout URL, merchant order tracking, merchant order cancellation and merchant refunds. The last three remain disabled/unverified until an actual integration exists. This endpoint is our registry, not a discovered Reap capabilities endpoint.

Expose supported configured stores/currencies, max quote lines (20), and max product-details batch size (10). The currency list contains tested configuration only; it must not imply Reap supports every ISO currency.

### 5.2 `getWallet` — GET `/users/{userId}/wallet`

Return mapped account status, funding/authorization mode, available balance, configured virtual-asset units, withdrawable units and observation time. Provider calls: `GET /accounts/{id}`, `/balance` and `/assets`. B must verify the account belongs to the mapped user, not trust a client-supplied account ID. [Get account](https://docs.reap.global/api-reference/accounts/get-account)

`availableBalance` is not A's spendable balance after local holds. A computes its own committed/uncommitted position atomically, tracking which successful debits are already reflected in provider snapshots so they are not subtracted twice. Compare against both account headroom and eligible-asset limits. Do not sum withdrawable caps across assets.

Reap warns that virtual `WITHDRAWAL` only prevents a negative asset balance, not a negative overall available balance. Read the asset's `withdrawable` cap before each debit. Reads and writes are not a reservation: they still race unrelated spending. [Posting guidance](https://docs.reap.global/virtual-assets/postings)

### 5.3 `listCards` — GET `/users/{userId}/cards`

Optional diagnostics for Reap-issued cards: masked identifier, status, account and last four digits. Map to `GET /cards?accountId=…`, paginated. Return no PAN or CVV. A participant paying through virtual credits does not need a Reap-issued card. [List cards](https://docs.reap.global/api-reference/cards/list-cards)

### 5.4 `listEnrollments` / `getEnrollment`

Routes: GET `/users/{userId}/enrollments`; GET `/users/{userId}/enrollments/{enrollmentId}`.

Return enrollment status, owner reference, masked payment metadata and `nextAction`. List is owner-scoped; B supplies `ownerType` and `ownerId` from its verified mapping. Missing wallet or card metadata does not mean zero funds. [List enrollments](https://docs.reap.global/api-reference/agentic/list-enrollments), [Get enrollment](https://docs.reap.global/api-reference/agentic/get-enrollment)

### 5.5 `createEnrollment` — POST `/enrollments`

Input: designated purchaser user ID, email, HTTPS return URL, operation context. B uses `source: EXTERNAL` and a `CLIENT_REFERENCE` owner. Return the enrollment and private hosted action. Only the purchaser completes card entry. Check status after return; a browser redirect is not activation.

The endpoint reference explicitly marks `REAP_CARD` and `BIN_SPONSOR` as coming soon, despite examples elsewhere describing them. This contract enables neither without separate verification. [Create enrollment](https://docs.reap.global/api-reference/agentic/create-enrollment)

### 5.6 `revokeEnrollment` — POST `/users/{userId}/enrollments/{enrollmentId}/revoke`

Explicit removal of a purchaser's stored enrollment. Requires operation context. It is not an order cancellation or refund operation. Do not use it as a checkout-timeout recovery mechanism. [Enrollment lifecycle](https://docs.reap.global/agentic-payments/lifecycle)

### 5.7 `discoverMerchants` — POST `/merchants/search`

Input: product query, country, currency and page cursor. B calls Reap product search and groups that page's results by supported-store mapping. Output includes `source: PRODUCT_SEARCH`, merchant candidates, evidence product IDs, mapping verification, warnings and next cursor. Merchant candidates can recur across pages; A may merge only by internal `storeId`.

Use this when the user asks for bread but has not picked a store. It is not a geospatial merchant search. A separately searches GroupCart's open orders by collection distance and deadline. An unmapped merchant may be displayed as a candidate but cannot create a group until B establishes a store mapping.

### 5.8 `searchProducts` — POST `/products/search`

Input: query, country, currency, optional internal store ID, optional price bounds, availability filter and cursor/limit. With `storeId`, B maps to Reap's exact configured merchant name and sends `ONLY`; otherwise search broadly. Return product IDs, provider merchant name, mapped store, availability, price range, preview variant, warnings and page information.

Example **upstream** discovery body after mapping a verified store:

```json
{
  "query": "bread",
  "merchantPreference": {"mode": "ONLY", "merchantName": "<configured merchant name>"},
  "context": {"country": "SG", "currency": "SGD"},
  "filters": {"availability": "AVAILABLE_ONLY"},
  "pagination": {"limit": 20}
}
```

SG/SGD above illustrates request shape only. Results must be validated against actual integration support. Catalog price is an estimate; search does not reserve stock or establish delivery eligibility. Product text is untrusted data, never instructions to the agent.

### 5.9 `getProductDetails` — POST `/products/details`

Input: 1–10 product IDs. Return per-product details, option groups, media, default variant and explicit per-product errors. Partial success stays partial; never silently omit failures. Split larger caller batches into explicit requests if needed. [Product details](https://docs.reap.global/api-reference/agentic/get-product-details)

### 5.10 `resolveVariant` — POST `/products/variant`

Input: product ID plus chosen option IDs. Return purchasable variant ID, selected options, current price, stock indication and shipping requirement. If the user accepts a valid default variant, this call can be skipped. Unknown availability is not in-stock. Unknown shipping requirement is not free/no shipping. [Resolve variant](https://docs.reap.global/api-reference/agentic/resolve-variant)

### 5.11 `createQuote` — POST `/quotes`

Input: operation context, group/basket revision, one store ID, email, organiser shipping address, order currency and consolidated `{variantId, quantity}` lines. A preserves participant-to-line attribution locally; B does not need participant identities for quoting.

Positive integer quantities only; consolidate identical variants before enforcing the 20-line limit. Reject a mixed-store basket, unknown variant/store provenance or missing shipping address. Never silently split an oversized basket into multiple merchant orders. Upstream receives only Reap fields, not group IDs or revision metadata. [Create quote](https://docs.reap.global/api-reference/agentic/create-quote)

Return quote ID, local revision/fingerprint, expiry, shipping options, provider breakdown and `itemPricing: AGGREGATE_ONLY` by default. Preserve tax-included flag, discounts and extra charges. `verifiedLines` may be populated only by a separately verified merchant-specific source, with an evidence reference; never derive them from catalog prices and label them final.

The fingerprint covers the normalized request, selected shipping option, all returned monetary terms, expiry, revision and quote ID. Persist canonical bytes/hash so both engineers do not independently implement different hashing conventions. B is the authority for the fingerprint; A stores and returns it unchanged.

### 5.12 `getQuote` / `selectShippingOption`

GET `/quotes/{quoteId}` refreshes the provider snapshot. POST `/quotes/{quoteId}/shipping-option` takes operation context, expected fingerprint and shipping option ID. Repricing changes the local revision/fingerprint; A invalidates affected allocations, approvals and holds. A new provider quote is needed on `QUOTE_REPLACEMENT_REQUIRED` or expiry. Do not assume repricing extends expiry. [Get quote](https://docs.reap.global/api-reference/agentic/get-quote), [Shipping selection](https://docs.reap.global/api-reference/agentic/select-shipping-option)

B serializes quote mutations against checkout submission. When checkout submission starts, freeze that quote for the attempt. A stale fingerprint returns `QUOTE_CHANGED`; do not submit payment using the newly observed total.

### 5.13 `createCheckout` — POST `/checkouts`

Input: operation context, group order ID, unique purchase-attempt ID, quote ID + expected fingerprint, purchaser user ID + enrollment ID, exact approved total, and HTTPS return URL. A calls only after it has locked baskets, obtained final participant approvals and reserved shares. Approval at join time alone is insufficient when final amounts are not known.

B refreshes quote and enrollment, validates ownership, currency, exact approved total, expiry and fingerprint, then creates one checkout. It must maintain a durable unique link from `purchaseAttemptId` to the provider request and checkout. A new idempotency key cannot bypass that uniqueness. [Create checkout](https://docs.reap.global/api-reference/agentic/create-checkout)

Return `REQUIRES_ACTION`, `PROCESSING`, `COMPLETED`, `FAILED`, `EXPIRED`, or our protective `UNKNOWN`, plus provider status and private hosted action when present. An absent action is not success. The selected purchaser receives the link; participants' wallet approvals do not replace the purchaser's hosted approval.

### 5.14 `getCheckout` — GET `/checkouts/{checkoutId}`

Refresh until terminal. `COMPLETED` establishes merchant order placement; persist order ID and actual `finalAmount`. If either is missing, retain completed provider status but set `reconciliationReady: false` and escalate. A redirect, timeout or network failure never proves purchase failure. [Get checkout](https://docs.reap.global/api-reference/agentic/get-checkout)

Only confirmed `FAILED`/`EXPIRED` permit a newly approved purchase attempt. Keep holds while status or submission outcome is uncertain. On `COMPLETED`, compare actual total against the approved allocation. A difference requires reconciliation; do not silently over-debit anyone or repurchase.

### 5.15 `debitWallet` — POST `/wallet-debits`

Input: operation context, group ID, checkout ID, participant/user IDs, immutable allocation ID, consent reference, exact approved debit and final debit. A validates authenticated participant consent and owns its evidence; B retains the reference and verifies the monetary bounds. For v0.1 these amounts must be equal.

B requires a known completed checkout ready for reconciliation, same currency, eligible account/asset, and a unique `(groupOrderId, participantId)` debit record. Refresh debit headroom; convert money to the configured 1:1 asset units; send one `WITHDRAWAL` posting per participant. Zero-share participants get a local `NOOP` record, not an invented provider posting.

Before dispatch, reserve each debit amount against the checkout's unallocated final total in B's journal, atomically with duplicate checking. Confirmed plus unresolved debit amounts must never exceed that total. Individual approved shares and conservation of the complete allocation remain A's responsibility.

Return local debit ID, posting ID when known, state, amount and optional balance-after snapshot. Posting success and balance-read success are separate: a failed read after a successful posting must not trigger a second debit. Multiple participants are separate operations; there is no cross-account atomic group debit.

### 5.16 `getWalletDebit` / `retryWalletDebit` / `getOperation`

GET `/wallet-debits/{debitId}` returns the journal result and, when a provider ID is known, verifies it through `GET /postings/{id}`. A posting resource contains type, entries and creation information; our `APPLIED/UNKNOWN/REJECTED` state is wrapper bookkeeping, not a Reap posting-status enum. [Get posting](https://docs.reap.global/api-reference/virtual-asset-postings/get-posting)

GET `/operations/{operationId}` recovers a command after connection loss. This route reads our journal. `UNKNOWN` requires reconciliation before any replacement command. A lost response is not resolved by guessing from a changed balance.

POST `/wallet-debits/{debitId}/retry` explicitly retries a **definitively rejected** debit after its cause is fixed. Input: debit ID and a new operation context. Keep the original debit/account/amount/allocation/consent identity; revalidate consent applicability and funds. B creates a new upstream posting-attempt key only after proving the previous attempt did not apply. `APPLIED`/`NOOP` returns the existing result; `UNKNOWN` blocks replacement and calls for recovery of the original attempt. Serialize retry attempts on the existing debit record and retain every provider-attempt record. `debitWallet` called again for an existing participant always returns that original debit; it does not implicitly restart it.

### 5.17 Optional helpers, separate from the core interface

- **Read/manage mandates:** Reap documents get, pause, resume and cancel. Mandate status also includes `CONSUMED`, `EXPIRED`, and `FAILED` in the endpoint schema, beyond the shorter guide table. A consumed one-time mandate cannot authorize a second purchase. The reviewed checkout request has no `mandateId`, and the inventory provides no mandate-create endpoint; ask Reap how mandates are obtained/associated before depending on reuse. [Get mandate](https://docs.reap.global/api-reference/agentic/get-mandate)
- **Activity reconciliation:** `GET /activities` with `type=POSTING`, account/asset filters and pagination can help investigate missing posting outcomes. Matching an amount/time is not conclusive proof of operation identity. [List activities](https://docs.reap.global/api-reference/activities/list-activities)
- **Issued-card spend policies:** useful diagnostics if we later use Reap-issued cards. Read effective inherited policies, not only the card's directly attached policies. These do not expose an external bank card's credit availability. [Effective policies](https://docs.reap.global/api-reference/policies/list-effective-policies)
- **Onboarding:** Reap user/account creation and KYC can become separate wrapper modules. Account creation requires an eligible verified owner; the demo should use pre-provisioned accounts. Do not make every Telegram join create an account/card. [Create account](https://docs.reap.global/api-reference/accounts/create-account)
- **Reversing a participant debit:** a controlled virtual `DEPOSIT` can compensate an erroneous virtual debit. It is not a merchant refund. Keep it operator-controlled for v0.1, linked to the original debit, capped at its unreversed amount, idempotent, and permitted only after the original outcome is known.
- **External checkout URL and offer codes:** potentially useful later; not core. URL support requires merchant/domain enablement. An offer code is an optional pricing input, not discount negotiation. Do not accept arbitrary LLM-generated checkout URLs.

### 5.18 B's upstream route map

These are **Reap routes**, unlike the internal routes above. Provider IDs replace the path placeholders. Internal metadata must not be forwarded as extra provider fields.

```text
Wallet:       GET  /accounts/{id}
              GET  /accounts/{id}/balance
              GET  /accounts/{id}/assets
Issued cards: GET  /cards?accountId=...
Enrollments:  GET  /agentic/enrollments?ownerType=...&ownerId=...
              POST /agentic/enrollments
              GET  /agentic/enrollments/{id}
              POST /agentic/enrollments/{id}/revoke
Discovery:    POST /agentic/products/search
              POST /agentic/products/details
              POST /agentic/products/variant
Pricing:      POST /agentic/quotes
              GET  /agentic/quotes/{id}
              POST /agentic/quotes/{id}/shipping-option
Purchase:     POST /agentic/checkouts
              GET  /agentic/checkouts/{id}
Wallet debit: POST /postings/                 (type WITHDRAWAL)
              GET  /postings/{id}
```

`getCapabilities`, store-ID mapping, merchant-result grouping, allocation checks, debit retries and operation-journal reads are wrapper behavior; Reap has no equivalent single endpoint for them in this reviewed flow. Preserve the trailing slash where shown by the reference client, and verify the configured client's redirect behavior before sending authenticated mutations.

## 6. End-to-end call sequence

```mermaid
sequenceDiagram
    participant A as Orchestration
    participant B as Reap wrapper
    participant R as Reap
    participant P as Designated purchaser
    A->>B: getCapabilities; getWallet
    A->>B: discoverMerchants / searchProducts
    B->>R: Search products
    R-->>B: Products, merchants, estimates
    B-->>A: Normalized results + coverage warnings
    Note over A: Match/start nearby group; collect separate baskets
    A->>B: getProductDetails / resolveVariant
    Note over A: Cutoff; freeze baskets; consolidate variants
    A->>B: createQuote; selectShippingOption if needed
    B->>R: Quote combined basket to organiser address
    B-->>A: Quote, expiry, total, price-evidence quality
    Note over A: Resolve price attribution; allocate costs; obtain final approvals; hold funds
    A->>B: createCheckout(attempt, fingerprint, approvedTotal)
    B->>R: Create checkout with one enrollment
    B-->>A: Status + hosted action
    A-->>P: Private approval link if required
    P->>R: Review and approve
    A->>B: getCheckout
    B->>R: Read checkout
    B-->>A: COMPLETED + orderId + finalAmount
    loop Each participant
        A->>B: debitWallet(approved allocation)
        B->>R: WITHDRAWAL posting on participant account
        B-->>A: Applied / unresolved / rejected
    end
    Note over A: Reconcile all shares; send receipts; organiser confirms arrival
```

## 7. Allocation and approval invariants — A owns these

1. A buyer's item amount refers only to that buyer's quantities. The same variant in two baskets can be consolidated for Reap while retaining the attribution map.
2. Quote after cutoff for final approval; earlier numbers are estimates. If approval cannot finish before expiry, obtain a new quote and reapprove. Never retain an expired quote just because its total looks unchanged.
3. Default final approval is exact: basket version, quote fingerprint, allocation version, currency, amount, collection details and authenticated participant ID. Changes invalidate approval before submission. The lone organiser explicitly accepts the full delivery fee.
4. Delivery is split equally only if the team adopts that rule. For a nonnegative delivery fee `D` minor units and `n` participants, allocate `floor(D/n)` each and distribute the `D mod n` remaining units by stable participant ID order.
5. Never add included tax twice. Preserve other fees and discounts even though negotiation is out of scope. Any aggregate charge without an agreed attribution rule blocks final approval.
6. Catalog unit prices are not verified checkout prices. Even a matching subtotal does not establish individual line prices. A may use an explicitly agreed estimate-based allocation policy only with disclosure and recorded consent; this changes the strict item-cost interpretation.
7. Every finalized allocation must sum exactly to the merchant charged total. If a provider total conflicts with its breakdown, retain evidence and stop automatic allocation. Do not copy the guide's sample arithmetic: some example totals do not add up when tax is marked excluded.
8. Participant debit amounts never exceed their authorization. Do not issue extra debits to repair a higher final merchant charge without a new, explicit adjustment flow. A lower actual charge also needs a reconciled allocation before capture in this exact-amount contract.
9. Final merchant charge plus all participant operations form a recoverable workflow, not a distributed database transaction. A failed participant debit after purchase means `RECONCILIATION_PENDING`; it does not mean checkout failed or the merchant order should be bought again.

Illustrative fixture, not Reap data: A's bread is 400 minor units, B's milk 600, C's fruit 800; delivery is 600. With no extra charges and verified line prices, approved shares are 600, 800, 1000 and the merchant total is 2400. Use the configured currency; these values do not demonstrate merchant support.

## 8. Errors, idempotency and recovery

The companion `WrapperError` separates provider errors from local validation. Return safe messages plus `providerCode`, request/operation identifiers, and an explicit recovery instruction. Unknown enum values map to `UNKNOWN` with the raw value retained; never map them to success.

Suggested HTTP mapping: invalid input 422; ownership/access 403; missing mapping/resource 404; changed quote, idempotency conflict or precondition failure 409; rate limit 429; unverified feature/configuration 503; invalid provider payload 502. A journaled operation with an uncertain upstream outcome returns 202 and a recoverable operation reference, not a false definitive failure. Synchronous reads and completed commands return 200.

Reap caches idempotent responses for **24 hours**, including most errors; `401`, `422`, `429` are excluded. Identical retries replay; concurrent same-key requests may return `IDEMPOTENCY_REQUEST_IN_PROGRESS`; changed bodies return `IDEMPOTENT_PARAMETER_MISMATCH`. After the window, the same key can execute again. B's durable operation/attempt/participant uniqueness must outlive that window. [Idempotency](https://docs.reap.global/api-reference/idempotency)

Recovery rules:

- Network loss on mutation: mark outcome unknown, retain the same key/body, and reconcile through the existing resource or replay within the safe window. Never auto-generate a new key for a possible charge.
- Repeated cached 5xx: stop blind retries and investigate. Do not assume each same-key retry starts a new attempt.
- Unresolved creation after provider cache expiry: hold for manual/provider reconciliation. Neither a 404 nor absence from a partial activity page proves it never happened.
- Confirmed quote validation/business error: fix the input; a genuinely new quote gets a new operation/key. `QUOTE_EXPIRED` and `QUOTE_REPLACEMENT_REQUIRED` require a replacement quote, revised allocation and approvals.
- Confirmed checkout terminal failure: a new attempt requires a new quote and explicit orchestration decision. Unknown status cannot take this branch.
- Debit succeeds, response or balance read fails: recover that debit only. Never rerun checkout or already successful participant postings.
- A has one scheduler for business retries; B handles bounded transport recovery and exposes the next action. Avoid two independent infinite retry loops.

Reap limits are project-wide, including across API keys. Honor `Retry-After` and rate-limit headers. Use a shared limiter and jittered polling; back off long-running checkout polls without declaring failure. The documented sandbox default is 10 requests/second, 150/minute, 10,000/day, subject to project configuration. [Rate limiting](https://docs.reap.global/api-reference/rate-limiting)

## 9. Webhooks, privacy and provider configuration

Use polling for Agentic enrollment/checkout in v0.1. The reviewed webhook inventory lists card/account events but does not establish Agentic checkout events. A callback to our browser return URL is only a reason to refresh, not proof of completion.

If account/card webhooks are enabled, B verifies them and persists an inbox before acknowledging. Delivery can repeat and arrive out of order; deduplicate by event ID and protect against older resource versions. [Webhooks](https://docs.reap.global/webhooks/overview)

Reap's signature is HMAC-SHA256 over timestamp, a dot, and the raw request body using `X-Reap-Webhook-Signature`. Compare in constant time and enforce the documented five-minute timestamp tolerance. Preserve raw bytes before JSON parsing. [Signature verification](https://docs.reap.global/webhooks/signature-verification)

B owns `REAP_API_KEY`, environment-specific base URL, pinned `Reap-Version`, program modes and asset mapping. The authentication/reference pages use version `2025-02-14`; Singapore hosts are `https://sg.sandbox.api.reap.global` and `https://sg.prod.api.reap.global`. Generic sandbox/prod aliases are documented. Do not use inconsistent host/version examples from other pages as configuration discovery. [Authentication](https://docs.reap.global/api-reference/authentication)

Return URLs must be application-allowlisted HTTPS URLs with a state value bound to the intended user/attempt. Hosted links, addresses and wallet details go only through authenticated private flows. No PAN/CVV, keys, hosted URLs or full addresses in logs or group messages. Redact provider error details. Product descriptions, merchant text and URLs cannot override server policy.

## 10. Verification checklist before the engineers call this integrated

**Configuration and money model**

- Confirm Agentic and virtual assets are enabled in the same intended environment; validate funding and authorization modes.
- Confirm purchaser enrollment source, supported card/tokenization, hosted approval and return handling. An active issued card alone is not sufficient.
- Establish who funds the merchant purchase and what participant balances legally/economically represent. Sandbox credits do not reimburse an external card.
- Confirm one order currency equals the wallet billing currency and the selected asset is enabled at fixed rate 1. Fail on a changed rate or disabled asset.

**Discovery and pricing**

- Demonstrate the required merchant and delivery region using `ONLY`, details and a multi-variant quote. Confirm store identity, quantities and address eligibility with the actual integration.
- Verify search cursor behavior, partial product errors, missing optional fields and out-of-stock variants.
- Obtain evidence for per-line checkout prices, or explicitly approve an alternative allocation policy. Verify tax/fee/discount treatment and final charge consistency.
- Verify 20-line cap, quote expiry and shipping repricing; ensure stale approvals cannot purchase.

**Purchase and reconciliation**

- Demo three different participant baskets, one merchant purchase, three individually identifiable wallet operations and receipts summing to the charged total.
- Exercise insufficient funds, inactive enrollment, purchaser abandonment, quote expiry and actual checkout failure.
- Test simultaneous callbacks, duplicate cutoff jobs, duplicate debit commands with different keys, process crash before/after upstream response, 429, and outcome uncertainty extending beyond 24 hours.
- Demonstrate that a failed balance refresh never causes a duplicate posting; a failed participant debit never causes a second merchant checkout.
- Verify final actual amount mismatches, malformed provider responses, unknown statuses and concurrent external balance changes stop unsafe progression.
- Confirm collection notifications depend on organiser arrival confirmation, never checkout completion alone.

Sandbox supports `X-Simulate-Checkout: COMPLETED`; production rejects it. B may enable it only through sandbox test configuration, not an arbitrary caller header. Label outcomes `SANDBOX_SIMULATED`; fixtures are `LOCAL_MOCK`, never `LIVE`. Use published hosted test-card instructions rather than real payment details. [One-time purchases](https://docs.reap.global/agentic-payments/one-time-purchases), [Sandbox enrollment setup](https://docs.reap.global/agentic-payments/setup)

## 11. Documentation findings requiring Reap confirmation

1. **Source availability:** setup examples cover Reap/BIN-sponsor cards, but create-enrollment documentation marks both coming soon. Default to external enrollment.
2. **External checkout URLs:** the purchase guide/API document an allowlisted path while the FAQ describes it as planned/per-account. Gate it pending project-specific verification.
3. **Mandate bootstrap:** guides describe checking a mandate before purchase, but the reviewed public creation flow does not explain how our app acquires its ID. Do not invent a create-mandate request or add `mandateId` to checkout.
4. **Missing line prices:** aggregate quote pricing is insufficient evidence for exact per-buyer item attribution. Ask for an itemized quote/receipt or a merchant-specific solution.
5. **No established shipment/cancellation/refund contract:** use a separate merchant/organiser workflow until Reap supplies an applicable operation. Card disputes, card shipments, and simulated refunds are not substitutes.
6. **Example inconsistencies:** guide money totals, nullable actions and mandate status summaries are not always aligned with reference schemas. Preserve actual provider values, validate invariants and retain unknown states. Schema validation and a sandbox round trip are required before treating examples as fixtures.

This review covered the Agentic overview, setup, purchase flow, lifecycle, FAQ and endpoint inventory; search/details/variants; quotes/shipping/checkouts; account balance/assets, cards/enrollments, virtual postings, mandates, activity recovery, authentication, idempotency, rate limits and webhook delivery/security. Adjacent onboarding and effective-policy endpoints were assessed for scope. It is exhaustive for the proposed boundary at documentation level, not a claim that every Reap feature or merchant has been live-tested.
