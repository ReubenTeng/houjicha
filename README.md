# Houjicha

MCP server for group buying. An external AI agent searches merchants and manages group buys by calling tools on this server. The server is a thin adapter over the orchestration backend. It does not run the group-buy engine, take payments, or host its own model.

MCP is the interface this project is building. The repository includes an orchestration backend, a Reap sandbox wrapper and a Telegram prototype. A later Telegram adapter can call the same tools. Group-buy behavior does not depend on Telegram chat IDs or message templates.

## Architecture

- **MCP** exposes orchestration operations as tools. Identity comes from the host, not from a user id supplied by the model. Proposed tools, auth rules, and acceptance checks are in the [MCP handoff](docs/plans/mcp-handoff/README.md).
- **Orchestration** owns group-buy state, catalog search, matching, membership, approvals, deadlines, allocation, and domain events.
- **Payment** owns Reap integration, participant funding, merchant checkout, and reconciliation. The internal Reap wrapper contract is documented below.
- **Telegram** is an optional adapter. The current process only proves the bot stays up.

## Status

| Piece | State |
| --- | --- |
| MCP tools and contract | Proposed. See the [MCP handoff](docs/plans/mcp-handoff/README.md). |
| Orchestration backend | Implemented with PostgreSQL persistence and portable SQLite tests. |
| Payment / Reap wrapper | Real sandbox catalogue, details and quotes; four local mock wallets. Participant-funded execution remains a separate service. |
| Telegram bot | Runnable prototype. `/start` and `/tester` only. |

## MCP handoff

Start with [docs/plans/mcp-handoff/README.md](docs/plans/mcp-handoff/README.md).

- [Product rules](docs/plans/mcp-handoff/product-context.md)
- [Shared terms](docs/plans/mcp-handoff/glossary.md)
- [Integration contract](docs/plans/mcp-handoff/integration-contract.md)
- [Agent usage notes](docs/plans/mcp-handoff/agent-usage.md)
- [Acceptance checks](docs/plans/mcp-handoff/acceptance-checks.md)

The contract lists tools such as `search_catalog`, `find_group_buys`, `join_group_buy`, and `get_my_updates`. Those names are a proposal. No MCP tool debits a wallet or starts its own checkout.

## Current prototype: Telegram bot

This slice answers `/start` with `Bot is online.` and `/tester` with `hello` plus the time that message was sent. Group-buying commands are not part of it.

### Requirements

- Node.js 22 or newer
- npm 10 or newer
- A bot token from [@BotFather](https://t.me/BotFather)

### Setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:

```
TELEGRAM_BOT_TOKEN=123456789:AA...
```

The token is a BotFather string such as `123456789:AA...`: digits, a colon, then at least 30 letters, numbers, underscores, or hyphens.

The bot reads `.env` from the current directory when it starts. Existing environment variables win. A missing `.env` is fine if `TELEGRAM_BOT_TOKEN` is already exported.

### Run

```bash
npm run dev
```

Logs are single-line JSON. Info goes to stdout, errors to stderr. Lifecycle logs include the bot username. They do not include message text, names, or the token.

Open a private chat with the bot and send `/start` or `/tester`.

Ctrl+C, or `SIGTERM`, stops polling and then exits.

```bash
npm run build
npm start
```

`npm run dev` and `npm start` exit with status 1 if the token is missing or malformed.

### Checks

```bash
npm test
npm run typecheck
```

## Reap wrapper API reference

The provider-facing Reap adapter boundary is defined in TypeScript. The documentation
uses expandable service functions, argument tables, return types and examples.
It describes direct calls to an injected `ReapWrapper` TypeScript interface.

The newer [MCP handoff](docs/plans/mcp-handoff/README.md) describes the outer
orchestration interface; the [payment-service handoff](docs/plans/payment-service-handoff/README.md)
describes a group-payment workflow above the provider adapter. The orchestration backend is implemented; participant-funded payment execution remains separate.
The old external-card purchase followed by virtual-credit debits does not satisfy
the newer participant-funded-before-checkout requirement. Read the reconciliation
section in the engineering handoff before implementing either payment sequence.

```bash
npm run docs:generate
npm run docs:check
npm run docs:serve
```

Open [the API reference](http://127.0.0.1:8080/docs), or open
[the HTML file](docs/reap-wrapper-reference.html) directly in a browser.
Set `DOCS_PORT` to change the preview port.

- [Engineering handoff](docs/reap-wrapper-api.md)
- [TypeScript interface](docs/reap-wrapper-contract.ts)

Edit the TypeScript contract, then regenerate the page and function schema bindings.
`docs:check` checks TypeScript, method coverage and generated-file freshness.

## Real Reap sandbox catalogue

`npm run reap:catalog -- coffee` (also `reap:demo`) searches Reap and fetches details for the first result. `npm run reap:orchestration-demo -- coffee` searches through `Orchestration.searchCatalog` and reads the four USD 100 local mock wallets. Both commands load the ignored `.env` with Node's environment-file support and exit nonzero on provider errors. They never fall back to fixtures or create users, enrollments, checkouts or debits.

`src/reap/mock-users.ts` overrides only wallet/card/enrollment reads for the four demo identities. All catalogue and quote operations delegate to the real wrapper. Discovered merchant IDs are deterministic and persisted, but purchase eligibility remains UNVERIFIED. Quotes may be requested for discovered stores; checkout still requires a verified store.

`createReapOrchestrationPorts` stores exact variant-to-product mappings in SQLite and refreshes details by product ID, never by title. Supply fulfillment through the trusted callback. Quotes remain AGGREGATE_ONLY unless a trusted evidence callback supplies verified line allocation; orchestration blocks unsupported pricing. An optional separate payment executor must implement participant funding and recovery. Without it, execution/recovery fail with PROVIDER_UNAVAILABLE and lookup returns null.

Journal version 2 includes the provider origin and rejects older files. Keep journal and mapping files under ignored `.reap/`; reconcile old or unknown operations before replacing journals. The offline provider in `src/reap/demo.ts` is a test fixture only.
