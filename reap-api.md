# Reap API

Reap is a modular, API-first fintech platform. One project API can onboard people and companies, hold or collateralize spending balances, issue virtual and physical cards, authorize card spend, and notify your backend as those resources change.

You do not have to use every module. Most partners start with cards. What a given project can actually call depends on choices Reap locks in at setup, plus a few products that are documented ahead of being generally available.

As scraped on 9 October 2026 from the public docs and both OpenAPI specs. Contract addresses, limits, and roadmap status can change. Recheck the source pages linked at the bottom before building against a detail.

## What you can build

- Verify individuals with KYC and, in a corporate program, verify companies with KYB.
- Open user-owned or company-owned accounts and read available balance as assets minus liabilities.
- Accept stablecoin deposits, and on enabled projects accept a bank-transfer top-up of the master collateral account.
- Withdraw stablecoins from a user-funded wallet, with a second signature from the registered owner key.
- Issue virtual or physical cards, then freeze, block, reveal details, set a PIN, ship plastic, and add a card to Apple Pay or Google Pay.
- Let Reap approve card spend, or approve each authorization yourself within 1.6 seconds.
- Cap where, how much, and how often a card can be used.
- Track authorizations, clearing, reversals, refunds, declines, fraud alerts, and chargeback disputes.
- Represent off-platform balances as virtual assets so a card can spend against funds you still custody.
- Register signed webhooks, request fee statements, and drive the same lifecycles in sandbox without a live card network.
- Store a card for an agent to buy with, then send the user to a Reap-hosted approval page. Parts of this product are still gated or unpublished.

Airport lounge passes are described in the docs and are not part of the live API. See [Availability](#availability).

## Choices locked at setup

Reap sets these when the project is created. They do not change after launch, and they are independent of each other.

### Program mode

| Mode | Who is verified | Who owns the account | Where cards spend |
| --- | --- | --- | --- |
| Consumer | KYC per user | User only | That user's balance |
| Corporate, company-owned account | KYB for the company, then KYC per employee | Company | One shared company balance |
| Corporate, user-owned account | KYB for the company or trust, then KYC per user | User | That user's balance |

`ownerType: COMPANY` exists only in corporate programs. Every cardholder still needs an approved KYC application, even when the company owns the balance. Creating a user in corporate mode requires `companyId`.

### Funding model

| Model | Where user funds sit | What backs a card swipe |
| --- | --- | --- |
| User-Funded | A Reap-provisioned wallet per account | That wallet's approved stablecoin balance |
| Program-Funded | Your own custody | One master collateral account you keep topped up |

User-Funded accounts get deposit addresses. Program-Funded user accounts do not. The master account is the only account in a Program-Funded project that holds real crypto. Bank-transfer funding, when enabled, also credits that master account.

### Authorization mode

This choice applies only to Program-Funded projects. User-Funded spend is always authorized by Reap against the deposited balance.

| Mode | Who approves | Balance source of truth | If your systems are down |
| --- | --- | --- | --- |
| Managed | Reap | Virtual-asset balances you post into Reap | Reap keeps authorizing against the last balance you set |
| External | Your endpoint, in real time | Your ledger | The swipe is declined. There is no retry on the live transaction |

Reap remains the source of truth for what cleared the card network in both modes. Clearing, reversals, refunds, settlement, spend policies, and platform limits still run at Reap.

## Identity

KYC is the gate for accounts and cards. A user cannot get either until `application.status` is `APPROVED`.

The project uses one verification method, fixed at onboarding:

- **Managed KYC.** Reap runs the check. You embed a provider SDK. Reap returns a token when you advance the application.
- **Sumsub token sharing.** You pass a token for a verification you already completed in your own Sumsub account.
- **Universal KYC.** You submit a verified data pack and upload the supporting documents Reap lists in `nextAction`.

Application statuses are `NOT_STARTED`, `AWAITING_DOCUMENTS` (Universal KYC only), `IN_REVIEW`, `APPROVED`, `REJECTED`, and `RETRY_REQUIRED`. Outcomes arrive on `USER_APPLICATION_STATUS_UPDATED`. Do not show raw `rejectionLabels` to the end user. Some jurisdictions cannot be onboarded. The restricted list is not published. Ask Reap.

In corporate mode you can also:

- Create a company and start KYB.
- Use Managed KYB, which returns a verification URL, or Universal KYB, which takes a verified business pack, company documents, and identity documents for declared beneficial owners.
- List officers and ultimate beneficial owners, including archived people.
- Submit the Universal KYB pack only after the required documents are uploaded.

Company outcomes arrive on `COMPANY_STATUS_UPDATED`.

Deleting a user permanently deletes every card they hold and restricts their accounts. The accounts stay open because they can still hold value or card debt, but a restricted account authorizes nothing.

## Accounts and money

An account is the unit of spending. One account has one owner. Balance is:

```text
availableBalance = assets - liabilities
```

Assets are approved stablecoin deposits in User-Funded mode, or virtual-asset allocations in Managed Program-Funded mode. External authorization holds no per-user spendable balance at Reap. Liabilities are card holds and cleared spend not yet settled. All balance figures are in the project's billing currency. Unconfirmed on-chain deposits do not count until approved.

`GET /activities` is the chronological feed of fund movements: deposits, withdrawals, card transactions, and virtual-asset postings.

### Deposits

User-Funded deposit chains are Base, Polygon, and Solana. Program-Funded master-collateral chains are Ethereum, Polygon, and Solana. Ethereum is master-only. Base is user-deposit-only.

Production tokens are Circle USDC and Tether USDT. Base production accepts USDC only. Sandbox uses Reap test tokens: RUSDC on Base Sepolia, and both RUSDC and RUSDT on Ethereum Sepolia, Polygon Amoy, and Solana Devnet. A project accepts a subset of the platform list. Read the accepted assets from `GET /accounts/:id` rather than hardcoding them. Native gas tokens such as ETH or SOL are not accepted. The same contract address can mean a different sandbox token on another chain, so match chain and address together.

`GET /accounts/auth-message` returns a signer message that expires after 15 minutes. User-Funded account creation requires a signature per enabled chain family. EVM and Solana need different keys. Reap cannot replace a lost signer key. That key is the second signature on later withdrawals. Deposits and card spend do not need it.

Deposit detection and later approval or rejection arrive as `CRYPTO_DEPOSIT_CREATED` and `CRYPTO_DEPOSIT_STATUS_UPDATED`.

Enabled Program-Funded projects can instead read wire instructions from `GET /fiat-deposits/bank-details`. Quote the returned `reference` on the transfer, and read the instructions again before each transfer. The fiat deposit webhook fires only after the receiving bank has reconciled the transfer.

### Withdrawals

Crypto withdrawal endpoints move tokens out of a User-Funded wallet. Program-Funded programs record a user withdrawal as a virtual-asset posting, because those funds are not sitting in a per-user Reap wallet.

The withdrawal flow is initiate, mint a signing payload, have the registered owner sign it, then submit the signature. Reap holds the other key, so neither side can move funds alone. Funds are reserved while the withdrawal is open and stop backing card spend until the withdrawal completes, expires, is cancelled, or fails. The signature window is 15 minutes. Payloads are short-lived, and each new payload retires the previous one. Cancellation works only before the signature is submitted. A completed withdrawal cannot be reversed by Reap.

The requested amount is gross. The flat network fee comes out of it.

| Chain | Fee | Minimum withdrawal |
| --- | --- | --- |
| Base | 0.30 USD | 5 USD |
| Polygon | 0.30 USD | 5 USD |
| Solana | 0.75 USD | 5 USD |

`withdrawable` on the assets breakdown is the largest gross amount you can request on that chain after outstanding card spend. It is advisory. The authoritative check happens at initiation.

## Cards

Create a card for an approved user on an active account. `type` is fixed at creation:

- `VIRTUAL` is digital-only and active immediately.
- `PHYSICAL` is usable online immediately and can also be produced as plastic. It is one card, not a separate virtual card plus a plastic card.

Card status is `ACTIVE`, `FROZEN`, `BLOCKED`, or `EXPIRED`. Freeze is the reversible cardholder switch. Block is the hard stop. A card can be both. Status reports `BLOCKED` when both are set, and the `frozen` flag says the freeze is still there. Lifting a block returns that card to `FROZEN` if it was frozen first. Blocks you place, and most fraud blocks, are liftable. A Reap risk or compliance block (`blockReason.type: OTHER`) is not. Unblock then returns `409 CARD_BLOCK_NOT_LIFTABLE`.

A restricted account declines every authorization while its cards can still say `ACTIVE`. Read both statuses before telling a cardholder the card works. Account restriction uses decline reason `ACCOUNT_NOT_ACTIVE`.

Other card operations:

- Update phone and email on the user. Phone must be unique in the project and in E.164 form. The card uses the user's phone for OTP.
- Set a 4 to 12 digit PIN on a physical card. Sequences of three or more consecutive or repeated digits are rejected. Virtual cards have no PIN.
- Reveal PAN, CVV, and expiry through a single-use iframe or WebView URL that lasts 5 minutes. Do not log that URL.
- PCI-approved partners can instead retrieve an RSA-OAEP encrypted PAN payload. Everyone else gets `403 PAN_REVEAL_NOT_ENABLED`.
- Freeze, unfreeze, block, unblock, and permanently delete a card.
- Choose a card design assigned to the project, and set the project default.
- Push-provision a card into Apple Pay or Google Pay. Each call returns fresh single-use credentials for the wallet SDK. Manual entry of card details also works without that integration. Push provisioning requires separate onboarding.
- If the cardholder chooses SMS during wallet verification, `CARD_TOKENIZATION_REQUESTED` carries the OTP for about 2 minutes so you can show it in-app.

### 3D Secure

Online payments can require 3D Secure. The default method is `SMS`: Reap texts a code to the phone on the user. `WEBHOOK` sends `CARD_3DS_CHALLENGE_CREATED` and you approve or reject with `POST /card-3ds-challenges/:id/respond` within 5 minutes. Missing the window expires the challenge and the purchase fails. A rejection or expiry does not create a card transaction.

### Physical cards

Ship 1 card, or 2 to 200 cards, through a draft. Edit the destination, recipient, courier, and card set while the shipment is `DRAFT`, then submit. Submit is what contacts the manufacturer. Couriers you can request are DHL, FedEx, and local postal. After placement, the manufacturer may assign a different courier, including SF Express for some destinations. Unsupported countries, missing state or province, a bad phone dial code, and an unsupported courier are rejected.

Shipment status runs from `PLACED` through production, transit, and `DELIVERED`. `DELIVERY_FAILED` and `EXCEPTION` can recover. Only `DELIVERED` and `CANCELED` are terminal. Carriers can skip intermediate states. Each card in the box has its own production status. A bulk submit can return HTTP 207 when some cards are rejected and the rest proceed.

The plastic card is activated with the 6-digit code on the mailer. `GET /cards/:id/activation-code` is the recovery path when that code is lost. Verify the cardholder through your own channel before sharing it. A physical card can already be `ACTIVE` for online use while `physicalCardStatus` still says it is in transit.

### Fraud and disputes

Fraud monitoring can raise an alert you must confirm or decline inside its response window. Confirming blocks the card. You can also report a past transaction as fraud, which confirms it and blocks the card. The block itself arrives as `CARD_STATUS_UPDATED` with `blockReason.type: FRAUD_ALERT_CONFIRMED`.

A dispute challenges a cleared transaction for chargeback. Card, cardholder, and currency come from the transaction. Status changes arrive as `CARD_DISPUTE_STATUS_UPDATED`. A dispute won for the cardholder credits the original transaction with a `DISPUTE_REFUND` event. The transaction stays `CLEARED`.

## Card transactions

There is no "list all transactions" endpoint in the spec scraped here. You receive transactions on webhooks and can read one with `GET /card-transactions/:id`. `GET /activities` is the broader money-movement feed.

Statuses:

| Status | Meaning |
| --- | --- |
| `PENDING` | Approved authorization. Funds are on hold. |
| `CLEARED` | Merchant collected, or a refund or offline clearing was recorded. Later refunds stay in this status. |
| `VOID` | Fully reversed before clearing, or a zero-amount card check. |
| `DECLINED` | Reap, or your external authorizer, rejected it. Nothing was reserved. |

A transaction can also be created directly as `CLEARED` when the network clears offline, or when a refund has no matching purchase. Incremental authorizations add another authorization event and keep the same id. Clearing can be less than, equal to, or more than the authorized amount. Refunds reduce `amount.current` and do not change a cleared status.

Not every decline at a terminal becomes a Reap transaction. A merchant or network rejection that never reaches Reap creates no record. A `DECLINED` record means the attempt reached Reap and was rejected there, including a rejection returned by an external authorizer, and `declineReason` is populated.

### Spend policies

Policies are declarative and attach to one card, one cardholder, or the whole program. A transaction is declined if any applicable policy blocks it. A looser policy does not override a stricter one. Platform rules sit on top and cannot be turned off.

| Type | Effect |
| --- | --- |
| `MERCHANT_RESTRICTION` | Block a list of MCCs or merchant countries |
| `CHANNEL_RESTRICTION` | Block `POS`, `ECOMMERCE`, and/or `ATM` |
| `TRANSACTION_AMOUNT_LIMIT` | Cap one purchase |
| `SPEND_LIMIT` | Cap cumulative spend in a calendar window |
| `AUTHORIZATION_COUNT_LIMIT` | Cap the number of authorizations in a calendar window |

Spend and count limits can attach to a card or cardholder, not to the whole project through the API. Windows are calendar periods in UTC: daily, weekly (ISO week), monthly, yearly, or lifetime. They are not rolling 24-hour windows. Declines do not count. Reversals release usage. Refunds do not give the limit back. `GET /policies/effective` shows inherited policies plus remaining headroom.

The platform itself always declines automated fuel dispensers, MCC `5542`. In-store fuel, MCC `5541`, is not on that list. ATM cash has separate platform caps. For a USD program those are 3,000 per day and 3 withdrawals, 10,000 per month and 30 withdrawals, and 100,000 per year. An HKD program uses 25,000 / 3, 80,000 / 30, and 800,000. ATM withdrawals are also blocked in restricted jurisdictions, including mainland China, FATF-blacklisted countries, and OFAC-sanctioned countries. Reap can raise the ATM thresholds per program after review.

### External authorization

On an External project, Reap sends `CARD_AUTHORIZATION_REQUEST` to your endpoint and waits. You return approve or decline in the HTTP body within 1.6 seconds. A non-2xx, a timeout, or a body Reap cannot parse is a decline. This is the only webhook whose response Reap consumes. After you approve, you still have to reconcile clearing, reversal, and refund webhooks into your own ledger. Reap will not show a per-user spendable balance for you to read back.

### Cardholder fees

Fees are charged to the cardholder on top of the merchant amount:

- `FX_MARKUP`, in basis points, when the merchant currency is not the billing currency.
- Domestic and cross-border ATM fees, each as a variable basis-point rate plus a fixed amount.
- 100 basis points is 1%. A value of 0 turns that fee off.

Every project has one default row per fee type. An API key cannot change project defaults. An organization admin changes those in the dashboard. The API can create, update, and delete one account-level override per fee type. Settled transactions keep the fee version that priced them.

## Virtual assets

Virtual assets exist for Program-Funded projects on Managed authorization. They are unit balances Reap tracks for you. No crypto moves when you post one. The master collateral account is what actually backs the card network.

Use them to mirror balances you custody, or to issue credits such as cashback, bonuses, payroll allowances, and credit lines. Several assets on one account collapse into one available balance.

Define an asset once, with a `FIXED` rate you set or an `HTTP` rate Reap fetches. Then post against an account:

- `DEPOSIT` credits the asset.
- `WITHDRAWAL` debits it and fails if the balance would go negative.
- `SETTLEMENT` debits it and applies the priced value to outstanding card debt in one step.

Disabling an asset is permanent. Old balances remain but drop out of available balance, and new allocations are rejected.

You still have to keep the master account topped up. Authorizations require that account to cover outstanding program spend.

## Statements

Statements are beta CSV files of fees Reap billed you. The only documented type is card-transaction fees: purchases, ATM withdrawals, refunds, wallet provisioning, and 3DS authentication.

Request a UTC calendar range of at most 31 days. It cannot start before 1 June 2026, and it cannot include a day whose card data is not final yet. A day's data is final at 10:00 UTC the next day. Five statements can be preparing at once. `STATEMENT_STATUS_UPDATED` says `GENERATED` or `FAILED`. Download links last 5 minutes. Files remain available for 180 days. Columns can still change. Within one API version, new columns are added at the end, so parse by header name.

## Webhooks

Register HTTPS endpoints with a `mode`. `NOTIFICATION` is the default: async delivery, at most 5 active endpoints, and no way to subscribe to a subset of event types. `REQUEST` registers the one synchronous authorization endpoint on an External project. That endpoint is rotate-only and cannot be disabled. The signing secret is returned once, at create and at rotate. Disabling a notification endpoint is permanent. Create a new one to resume delivery to the same URL.

Deliveries are at least once, in no guaranteed order, and retries run for about 48 hours. Acknowledge with any 2xx quickly, dedupe on the event `id`, and ignore a payload whose `updatedAt` is older than what you stored. Verify HMAC-SHA256 over `{timestamp}.{rawBody}` using the raw body. Reject timestamps older than 5 minutes.

`CARD_AUTHORIZATION_REQUEST` is the exception: it is synchronous, and your response is the authorization decision.

The public webhooks guide lists 14 event types. The webhook OpenAPI spec scraped the same day lists 19. This guide follows the spec.

| Event | When it fires |
| --- | --- |
| `USER_APPLICATION_STATUS_UPDATED` | KYC application status changes |
| `COMPANY_STATUS_UPDATED` | Company KYB status changes |
| `ACCOUNT_STATUS_UPDATED` | Account restricted or reactivated |
| `CRYPTO_DEPOSIT_CREATED` | An on-chain deposit is detected |
| `CRYPTO_DEPOSIT_STATUS_UPDATED` | That deposit is approved, rejected, or otherwise updated |
| `CRYPTO_WITHDRAWAL_CREATED` | A withdrawal is reserved and waiting for a signature |
| `CRYPTO_WITHDRAWAL_STATUS_UPDATED` | Withdrawal moves through processing, completion, expiry, cancel, or failure |
| `FIAT_DEPOSIT_CREATED` | A reconciled bank transfer is credited |
| `CARD_STATUS_UPDATED` | Card activated, frozen, blocked, or otherwise changes status |
| `CARD_TRANSACTION_CREATED` | A new card transaction is recorded |
| `CARD_TRANSACTION_UPDATED` | Clearing, reversal, refund, or another lifecycle event |
| `CARD_AUTHORIZATION_REQUEST` | External authorization. Response body is the decision |
| `CARD_3DS_CHALLENGE_CREATED` | A webhook-method 3DS challenge needs a response |
| `CARD_SHIPMENT_STATUS_UPDATED` | Physical shipment status changes |
| `CARD_TOKENIZATION_REQUESTED` | Wallet provisioning asked for an SMS OTP |
| `CARD_FRAUD_ALERT_CREATED` | Fraud monitoring or a partner report created an alert |
| `CARD_FRAUD_ALERT_STATUS_UPDATED` | Alert confirmed, declined, or expired |
| `CARD_DISPUTE_STATUS_UPDATED` | Dispute status changes |
| `STATEMENT_STATUS_UPDATED` | A statement file is ready or failed |

Egress addresses, if you allowlist inbound webhook traffic:

| Environment | Source addresses |
| --- | --- |
| Singapore sandbox | `13.228.84.42/32` |
| Singapore production | `13.251.96.90/32`, `13.229.17.218/32`, `3.1.46.185/32` |
| Mexico sandbox | `78.14.100.165/32` |
| Mexico production | `78.13.78.56/32`, `78.12.158.189/32`, `78.14.99.200/32` |

## Sandbox simulation

These endpoints drive state you cannot otherwise force without a live network or a compliance reviewer. They are sandbox tools. A simulated user-application change is processed asynchronously, so the user may not show the new status when the call returns. Company simulation returns `204`. Observe either change with a GET or the matching webhook.

- Move a user application, company KYB outcome, account status, or card status.
- Rewind a submitted Universal KYB application so it can be submitted again.
- Walk a submitted shipment through production and delivery.
- Create an authorization, including an incremental one, and optionally raise a fraud alert with it.
- Create a webhook-method 3DS challenge without creating a transaction yet.
- Decline, clear, reverse, or refund a transaction. Clearing and refund can also be simulated with no prior authorization.
- Credit a fake settled fiat deposit on a Program-Funded project.

Real sandbox deposits and withdrawals still use the public testnets and Reap test tokens. Reap pays testnet gas.

## Agentic payments

This is a separate commerce flow from card issuing. An agent can search merchant catalogs, price an order, and open a checkout against a stored card. The user approves the charge on a page Reap hosts. Your servers do not see the card number. Reap completes the merchant order and returns the order reference.

The documented sequence is:

1. `POST /agentic/enrollments` stores a card. The feature must be enabled on the project, and the card must support Visa Token Service tokenization.
2. `POST /agentic/products/search`, then product details and variant resolution.
3. `POST /agentic/quotes` prices the order. Quotes expire quickly. Shipping selection re-prices the quote.
4. `POST /agentic/checkouts` opens a Reap-hosted approval page against an `ACTIVE` enrollment.
5. Poll the checkout until it reaches a terminal status. A completed checkout carries the merchant order reference and the charged amount.

Enrollment sources in the setup guide are `EXTERNAL` (hosted card entry), `REAP_CARD`, and `BIN_SPONSOR`. The create-enrollment description in the docs index still says `REAP_CARD` and `BIN_SPONSOR` are coming soon. Treat those two sources as not confirmed live until Reap says otherwise. `EXTERNAL` is the source the index describes as available.

Mandate read, pause, resume, and cancel endpoints are in the OpenAPI spec. The product overview says mandates are published ahead of release and are not live in sandbox or production.

Other gates from the FAQ, which tells you to confirm before building:

- Custom checkout URLs, for an agent that finds the product itself, are planned and not shipped.
- Merchant coverage is per integration. Ask which merchants are live.
- An MCP server or CLI on top of this needs production approval from Visa and Reap. MCP clients are sandbox-only for now.

Sandbox test cards for the hosted enrollment page are `4622943123137797`, `4622943123137805`, and `4622943123137847`, expiry 12/27, with the CVC values in the setup guide. OTP for that flow is `456789`. Those cards are declined outside Agentic Payments.

## Availability

Confirmed in the docs or missing from the OpenAPI spec as of this scrape:

- **Airport lounge access is not available through the API.** The guide describes a future Priority Pass inventory flow, one single-use 365-day plan (`LOUNGE_PP_1PA`), and webhooks, but it says the product is coming soon. No lounge or rewards paths are in the API spec.
- **Agentic mandates, Reap-card enrollment, BIN-sponsor enrollment, custom checkout URLs, and production MCP clients are not safe to treat as live.** See the section above.
- **Raw card data requires PCI approval.** The normal integration is the short-lived reveal URL.
- **External authorization is a project-level mode, not a per-transaction option.**
- **There is no public endpoint to change program mode, funding model, authorization mode, or the KYC method.**
- **API key management is in the OpenAPI spec and not in the public docs index.** The spec can list, generate, update the IP allowlist, and revoke keys. The plaintext secret is returned once. Initial access still starts by contacting Reap.

## Calling the API

Send both headers on every request:

```http
Authorization: Bearer YOUR_API_KEY
Reap-Version: YYYY-MM-DD
```

The version header is required. A missing or unknown version is `400`. Docs examples use `2025-02-14` and `2026-01-01`, so confirm the version your project should pin rather than copying one example. Keys are project-scoped and environment-scoped. A sandbox key does not work in production. Each key can optionally be limited to IPv4 or IPv6 addresses and CIDR ranges. An empty list allows any IP. Reap checks the last `X-Forwarded-For` hop.

| Environment | Base URL |
| --- | --- |
| Singapore sandbox | `https://sg.sandbox.api.reap.global` |
| Singapore production | `https://sg.prod.api.reap.global` |
| Mexico sandbox | `https://mx.sandbox.api.reap.global` |
| Mexico production | `https://mx.prod.api.reap.global` |

`https://sandbox.api.reap.global` and `https://prod.api.reap.global` are aliases for Singapore.

List endpoints use cursor pagination. Pass `nextCursor` from the previous page. A null cursor is the last page.

Errors share one body:

```json
{
  "error": {
    "code": "USER_NOT_FOUND",
    "message": "User not found",
    "detail": null
  }
}
```

Branch on `code`, not only the HTTP status. Validation failures are `422 VALIDATION_FAILED`, with `detail.on` of `body`, `query`, `params`, or `headers`. Unknown fields are ignored, so a typo often shows up as a missing required field. Common cross-cutting codes include `API_KEY_REQUIRED`, `INVALID_API_KEY`, `API_KEY_IP_NOT_ALLOWED`, `API_VERSION_HEADER_MISSING`, `RATE_LIMIT_EXCEEDED`, and `INTERNAL_SERVER_ERROR`.

`Idempotency-Key` is optional on most POSTs and required on the money-moving and chargeable creates called out in the docs: account, card, virtual-asset posting, dispute, API key, and card-shipment submit. Agentic enrollment creation also requires it. The first response, including a business 4xx or 5xx, is cached for 24 hours. `401`, `422`, and `429` are not cached. The same key with a different body is `400 IDEMPOTENT_PARAMETER_MISMATCH`. A concurrent retry is `409 IDEMPOTENCY_REQUEST_IN_PROGRESS`.

Limits are per project, on rolling one-second, one-minute, and one-day windows. Not per key.

Production:

| Tier | Per second | Per minute | Per day |
| --- | --- | --- | --- |
| Default | 20 | 600 | 500,000 |
| Card issuance (`POST /cards`, shipment submit) | 10 | 100 | 5,000 |
| Card operations, disputes, shipment create | 15 | 250 | 10,000 |
| Identity verification and company create | 5 | 150 | 2,000 |
| Account creation | 3 | 100 | 10,000 |
| Withdrawal initiate, payload, and sign | 6 | 60 | 5,000 |

Sandbox:

| Tier | Per second | Per minute | Per day |
| --- | --- | --- | --- |
| Default | 10 | 150 | 10,000 |
| Card issuance | 5 | 50 | 500 |
| Card operations | 5 | 100 | 1,000 |
| Identity verification | 2 | 30 | 300 |
| Account creation | 2 | 50 | 2,000 |
| Withdrawals | 6 | 30 | 500 |

A `429` uses code `RATE_LIMIT_EXCEEDED` and sets `Retry-After` in seconds. Responses also carry `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, and `RateLimit-Policy`.

Within one `Reap-Version`, Reap may add endpoints, optional fields, response fields, enum values, webhook types, and error codes without a new version. Removing or renaming fields, changing a type or meaning, or making an optional field required requires a new version. Treat ids as opaque variable-length strings.

## Endpoint inventory

The API spec contains 137 operations in 22 groups.

| Group | Ops | What those operations do |
| --- | --- | --- |
| Users | 8 | Create, list, get, delete, update phone or email, advance KYC, upload KYC documents |
| Companies | 13 | Create, list, get, advance and submit KYB, upload company and related-person documents, read officers and UBOs |
| Accounts | 6 | Create, list, get, balance, per-asset breakdown, signer message |
| Virtual assets | 6 | Define, list, get, update, disable, set a fixed rate |
| Virtual asset postings | 2 | Create and get a deposit, withdrawal, or settlement posting |
| Cards | 17 | Issue and manage cards, PIN, freeze, block, reveal, 3DS method, activation, push provisioning, 3DS respond |
| Card designs | 3 | List, get, set the default design |
| Card shipments | 8 | Draft, edit, add or remove cards, submit, list, get |
| Card transactions | 1 | Get one transaction |
| Fraud alerts | 4 | List, get, respond, report fraud |
| Disputes | 3 | List, get, file |
| Policies | 8 | Create, list, effective set, get, rename, replace config, enable, disable |
| Fees | 6 | List, effective set, get, create account override, update value, delete override |
| Crypto deposits | 1 | Get one deposit |
| Crypto withdrawals | 5 | Initiate, get, mint payload, submit signature, cancel |
| Fiat deposits | 2 | Bank details and get one deposit |
| Activities | 1 | List fund movements |
| Statements | 4 | Request, list, get, download |
| Webhooks | 6 | Create, list, get, update URL or name, rotate secret, disable |
| API keys | 4 | List, generate, replace IP allowlist, revoke |
| Agentic | 16 | Enrollments, mandates, product search, quotes, shipping, checkouts |
| Simulation | 13 | Sandbox status and transaction-lifecycle controls |

## Sources

- Documentation home: <https://docs.reap.global/>
- Page index: <https://docs.reap.global/llms.txt>
- API spec: <https://docs.reap.global/api-reference/openapi.json>
- Webhook spec: <https://docs.reap.global/webhooks/openapi.json>
- Authentication, errors, idempotency, rate limits, and versioning: <https://docs.reap.global/api-reference/authentication>
- Program mode, funding, and authorization: <https://docs.reap.global/program-configuration/overview>
- Supported assets: <https://docs.reap.global/accounts/supported-assets>
- Agentic payments: <https://docs.reap.global/agentic-payments/overview>
- Airport lounge access: <https://docs.reap.global/airport-lounge-access/overview>
