# Houjicha

MCP-first commerce and group-buy orchestration. An external assistant calls six tools; Houjicha does not host its own model. The Reap MCP application was imported from the local `reap-mcp` repository at `30f32c0` and now lives in `src/reap/`. Running Houjicha does not require that sibling repository.

Telegram remains an optional prototype. It is no longer the default application.

## Six MCP tools

| Tool | Purpose |
| --- | --- |
| `connect_payment_method` | Hosted card enrollment and verified enrollment status |
| `search_products` | Indicative merchant product search |
| `prepare_purchase` | Reviewable single-product draft and shipping selection |
| `request_purchase` | One approval-gated checkout for an exact purchase revision |
| `get_purchase_status` | Bounded status read of the saved purchase |
| `group_buy` | Action-based adapter over the existing group-buy orchestration core |

The first five tools retain the imported Reap contracts. They support explicitly labeled mock simulation and gated Reap sandbox access, not production payments. A conversational approval is not a substitute for hosted payment approval. Unknown outcomes must be reconciled using the original operation, never a replacement checkout.

### Group-buy actions

`group_buy` accepts an `action` plus that action's fields:

| Action | Fields beyond `action` |
| --- | --- |
| `search_catalog` | `query`, optional `merchantId`, `cursor` |
| `find_group_buys` | `merchantId`, `lines`, `constraints` |
| `get_group_buy` | `groupBuyId` |
| `create_group_buy` | `metadata`, `input` containing basket, collection, merchant, deadline, and trusted `authorizationRef` |
| `join_group_buy` | `metadata`, `groupBuyId`, `input` containing basket and trusted `authorizationRef` |
| `leave_group_buy` | `metadata`, `groupBuyId` |
| `close_group_buy` | `metadata`, `groupBuyId` |
| `cancel_group_buy` | `metadata`, `groupBuyId` |
| `respond_to_price_change` | `metadata`, `groupBuyId`, `approvalRequestId`, `decision` |
| `get_my_updates` | Optional `cursor`, `limit` |
| `get_payment_status` | `groupBuyId` |

Mutation metadata is `{commandId, expectedVersion}`. Reuse a command ID only for a retry with identical terms. Creation uses version `0`; existing groups require the last observed version. Identity is supplied by the authenticated transport, never by tool arguments.

Group money is `{currency: "USD", minor: "1200"}`. The five commerce tools use decimal major-unit strings instead. Do not interchange their product/variant IDs or money formats. `group_buy` catalog search returns concrete default variants with their option attributes; it does not select other options or infer substitutions.

Results include `data.action`, `data.result`, `data.capabilities`, and `data.freshness`. Catalog prices are `INDICATIVE`; read results are `STORED` snapshots, including group payment status. Mutation responses are `COMMAND_RESULT` and may be the original response on an idempotent replay. Read current state before acting on a replayed response.

**Group payments are deferred.** Neither imported Reap checkout nor the old virtual-debit wrapper implements the core's collect-first multi-participant payment contract. Trusted group-consent capture is also not connected. With the real group backend configured:

- Catalog search, stored group/update/payment reads, and organizer-authorized cancellation call the existing core.
- Discovery returns `GROUP_PAYMENT_UNAVAILABLE` until verified quote capability exists; this is not an empty search result.
- Create/join return `GROUP_CONSENT_UNAVAILABLE` until a trusted grant resolver is connected.
- Leave, close, and price responses are gated on the missing payment backend because they require repricing/finalization support.
- No group worker runs against missing dependencies. There is no mock fallback, fabricated grant, or single-purchase replacement for group funding.

The complete dispatcher can use injected real payment and consent ports later. Fixtures are used only in tests and the existing explicitly labeled orchestration demo. The service-only authorization lookup, worker tick, and reconciliation methods are not MCP actions.

## Architecture

- `src/reap/`: MCP HTTP/stdio transports, OAuth verification, commerce, provider adapters, PostgreSQL operations, and recovery.
- `src/group-buy/`: strict tool schemas, identity-aware dispatch, capability gates, Reap catalog mapping, and core composition.
- `src/orchestration/`: unchanged group lifecycle, permissions, allocation, persistence interfaces, events, and worker.
- `src/telegram/`: unchanged optional bot prototype.

HTTP checks issuer, audience, expiry, subject allowlist, and scopes. The same action-aware scope requirements are enforced at the group adapter: reads require `commerce:read`, mutations require `commerce:prepare`, and close/price responses additionally require `commerce:checkout`. Permissions never replace the core's ownership, version, or consent rules.

## Requirements

- Node.js `>=22.16.0 <23` or `>=24 <25` and npm 10+.
- A dedicated PostgreSQL database for commerce. Docker Compose supplies a local database if needed.
- Remote HTTP additionally requires an MCP-compatible OAuth provider. Local stdio does not.

## Local MCP setup

```bash
npm ci
npm run setup:local
```

`setup:local` creates a private mock `.env` only if no file exists. It never overwrites existing secrets. If `.env` already exists, merge the needed non-secret settings from `.env.example` and securely supply `DATABASE_URL`, `POSTGRES_PASSWORD`, and a base64-encoded 32-byte `DATA_ENCRYPTION_KEY`. Existing Telegram/Supabase settings alone do not configure MCP commerce.

The MCP runtime reads `.env` from the repository root even when launched from another working directory. Exported environment values win. `REAP_ENV_FILE` overrides the path; setting it to an empty string disables dotenv loading, useful for secret-managed deployments and isolated tests.

For the supplied **local disposable/development** database:

```bash
docker compose up -d db
npm run db:migrate
npm run dev:stdio
```

Compose binds PostgreSQL to loopback port `55433`, separate from the source repo's default `55432`. Check your database target before running migrations: commerce uses its own tables in the database's default schema. Do not apply these migrations to an arbitrary shared database.

An MCP host should launch the stdio process, using an absolute path to this repository's `dist/reap/stdio-main.js` after building:

```bash
npm run build
npm run start:stdio
```

The stdio process also serves hosted mock approval pages on `PUBLIC_BASE_URL` (port 3000 by default). Its HTTP `/mcp` route is disabled; the assistant connects over stdin/stdout. Operational logs go to stderr to preserve the protocol stream. No Telegram token is needed.

## HTTP MCP (default application)

Configure the OAuth fields in `.env.example` before using:

```bash
npm run dev
```

For compiled execution:

```bash
npm run build
npm start
```

The endpoint is `/mcp` on `PUBLIC_BASE_URL`. `OAUTH_AUDIENCE` must exactly match that endpoint. Configure an HTTPS issuer, MCP client registration (CIMD or DCR), S256 PKCE, and an explicit subject allowlist. Public or sandbox deployments require HTTPS; there is no unauthenticated HTTP demo-identity bypass. Startup reports a configuration error rather than silently switching transports.

The imported sandbox guards remain intact: monetary units, hosted URL hosts, merchant configuration, callback behavior, and per-purchase approval must be verified before enabling checkout. This import does not enable them or prove provider/project capabilities.

## Real group backend setup

Group wiring is optional and sandbox-only. Set `GROUP_BUY_ENABLED=true`, `GROUP_BUY_COUNTRY`, and `GROUP_BUY_CURRENCY`; the region must be explicitly allowed by the commerce configuration. Supply the existing `SUPABASE_*` database fields from Supabase's Connect dialog. `SUPABASE_URL` is a database hostname, not an HTTPS API URL. TLS verification stays enabled.

After checking the intended backend database, run these **explicit** setup steps:

```bash
npm run db:migrate
npm run db:setup:group
```

The first uses `DATABASE_URL` for commerce/catalog mappings; the second uses `SUPABASE_*` for group persistence. They can target separate databases. Neither runs automatically at startup.

`db:setup:group` applies the unchanged `supabase/schema.sql` template under a schema named `orchestration_<hash>`, derived from the Reap namespace, country, and currency. This isolates projects/regions without changing the core or its original `orchestration` schema. It does not import preexisting groups or demo state. RLS and backend-only privileges remain enabled. Keep these schemas out of Supabase's public Data API.

If group configuration is absent or invalid, all six tools remain discoverable and the five commerce tools remain independent. `group_buy` reports its unavailable backend. Enabling the real store/catalog does **not** enable the deferred consent and group-payment capabilities.

## Optional Telegram prototype

Set `TELEGRAM_BOT_TOKEN` from [BotFather](https://t.me/BotFather), then run `npm run dev:telegram` or, after building, `npm run start:telegram`. It still answers only `/start` and `/tester`; it is not connected to MCP or the group lifecycle.

## Verification

```bash
npm run typecheck
npm test
npm run build
npm run docs:check
npm run orchestration:demo
```

Default tests are offline and skip database integration explicitly. To exercise PostgreSQL and the source/compiled stdio processes, build first and supply **only disposable local databases** through `REAP_TEST_DATABASE_URL` and `ORCHESTRATION_TEST_DATABASE_URL`, then run `npm test`. The Reap suite applies its migrations and creates mock commerce records; the orchestration suite creates/removes generated test schemas. These tests never load the actual `.env` or contact Reap. HTTP tests exercise authenticated transport behavior with an injected test verifier.

The existing orchestration demo uses LOCAL_MOCK payments and proves lifecycle/recovery behavior, not real funding. No hosted database, real checkout, or money movement is needed for verification.

## Historical contracts and API reference

The [MCP handoff](docs/plans/mcp-handoff/README.md) describes the original separate-tool proposal. Its operations are now actions under the single `group_buy` tool. The [orchestration explanation](docs/explanations/orchestration-core.md) documents the unchanged core; the [payment-service handoff](docs/plans/payment-service-handoff/README.md) records the still-unimplemented multi-participant funding requirements.

The older `ReapWrapper` interface and generated reference remain separate from the imported single-purchaser commerce application. External-card checkout followed by virtual-credit debits does not satisfy participant funding before group checkout.

```bash
npm run docs:generate
npm run docs:check
npm run docs:serve
```

Open [the API reference](http://127.0.0.1:8080/docs), or [the HTML file](docs/reap-wrapper-reference.html). `DOCS_PORT` changes the preview port. Edit the [TypeScript contract](docs/reap-wrapper-contract.ts) before regenerating; `docs:check` verifies type safety, method coverage, and generated-file freshness. See the [engineering handoff](docs/reap-wrapper-api.md) for its provider assumptions.
