# Product context and decisions

Read this before implementing either component. This is a self-contained snapshot of the discussion, including the MCP-first pivot. No access to the original conversation or local skill library is required.

## Status and ownership

The original handoff was prepared against a documentation-only baseline. The current repository now includes a TypeScript Telegram starter and a documented ReapWrapper interface, but no group-buy orchestration implementation. See repository-status.md for conflicts and the current baseline. The contracts in integration-contract.md are PROPOSED interfaces to agree with the orchestration owner, not endpoints that already exist. Implement against a labeled mock while that backend is being built.

- O1: Orchestration owns durable group-buy state, catalog/search interface, matching, membership, participant limits, approvals, deadlines, allocation, and domain events.
- O2: MCP is a thin interface to orchestration. An external agent such as ChatGPT or another MCP-capable host performs conversation and invokes tools. No built-in agent, Telegram bot, or model SDK is required for the core.
- O3: Payment service owns Reap/Kwal integration, participant funding, collection, merchant checkout, provider approval flows, reconciliation, and refunds. It may expose provider catalog/quote data to orchestration.
- O4: A future Telegram adapter can use the same MCP tools. The core must not depend on Telegram chat IDs, message templates, MCP sessions, or any LLM.
- O5: Orchestration enforces all business permissions and invariants. A model prompt is not an enforcement mechanism.

## Agreed product rules

- R1: A group buy is by merchant, not by item. One Reap merchant can have multiple concurrent group buys with different collection details. Joining can add a new item from that merchant.
- R2: Each participant selects exact product variants and quantities. No automatic substitutions.
- R3: The organizer hosts collection, receiving and distributing the goods. They confirm a real collection point, collection window, and separate joining deadline before others join.
- R4: Collection details become immutable once another participant joins. Joining matches the existing arrangement, not a negotiation across participants.
- R5: A purchase request includes product, quantity, maximum total spend including fees, location, maximum travel distance, and collection-time constraints. Joining is autonomous only within genuine user authorization for these constraints. Creating a group buy is separately opt-in because it creates hosting responsibilities.
- R6: Filter out ineligible group buys, then rank by nearest collection point and earliest collection window. Return up to three with reasons. Sharing a merchant alone is not sufficient eligibility.
- R7: Deadline expiry or an organizer's early-close action stops new joins. One participant is enough if the merchant accepts the order and the participant's limit covers the final total.
- R8: Each participant covers their own items. Shared delivery fees are split equally per participant. Recalculate whenever the order changes, including someone leaving.
- R9: If anyone's revised total exceeds their authorization, ask that person to accept or reject. Block purchase while any required response is outstanding. There is NO five-minute response deadline and silence is not approval.
- R10: Acceptance applies to a specified revised total/order context, not unlimited increases. Rejection removes that participant and triggers recalculation, which can cause further approval requests.
- R11: An unavailable item blocks the whole checkout in the first version. No silent partial order.
- R12: Participants must actually fund their shares in the sandbox. Merely displaying allocations against an organizer-funded purchase does not meet the requirement.
- R13: If Reap requires a merchant-payment approval action, route it to the organizer as the designated approver. The payment service must verify that person is permitted to approve the chosen funding source. This is separate from participant spending-limit approval.
- R14: Persist notifications for joins, required approvals, participant removal, cancellation, and payment success/failure. With MCP, clients fetch updates. Unsolicited messages cannot be assumed to reach an offline agent.

## Provisional defaults: use unless implementation exposes a material conflict

These were recommendations adopted as working defaults to save time, not individually confirmed product requirements.

- P1: Lock membership and quantities before participant collection begins. This replaces the earlier checkout-start cutoff because funds can move before merchant checkout.
- P2: If collection definitively fails after some participants paid, do not order a subset. Recover/refund collected contributions. Remain locked until financial recovery is confirmed. An unknown outcome is not failure.
- P3: Organizer cancellation is allowed before collection starts. Afterwards use payment recovery, not an immediate state reset.
- P4: Refresh expired quotes before spending. Pending price approvals have no arbitrary timeout, but an objectively infeasible collection window can cancel the buy before collection. Do not invent delivery guarantees.
- P5: For the demo, use a request-specific location and straight-line distance, clearly labeled. Require the offered collection window to fit the user's availability.
- P6: Use one agreed currency per buy. Allocate item charges to their items and shared fees equally. Round in integer minor units with a stable participant-ID remainder rule. Complex discounts and FX are deferred.

## Relevant interview history

- H1: We considered a hosted agent and Telegram first. The latest direction is external agents through MCP. Neither is a dependency of orchestration.
- H2: We briefly considered a single shared test card plus internal allocations. The user rejected that because every participant must be charged.
- H3: We considered a five-minute deadline for price approval. The user rejected it. Wait for accept/reject responses, subject to quote validity and feasibility.
- H4: Multiple wallets are supported by public Reap documentation, but split checkout was not established. The payment-service teammate owns resolving the actual flow.
- H5: The user wants a high threshold for questions. Pick reversible engineering defaults and record them. Ask only about changed scope, payment authority/custody, or irreversible financial behavior.

## Sandbox and unknowns

Reap's hackathon requires Agentic or Kwal with Agentic. Merchant checkout is simulated, with no real merchant delivery. Testnet token transfers can still occur.

The reported approximately 300 USDC allocation, team funding model, enabled APIs, chain, token, and wallet-backed checkout balance effects are unverified. Payment owns this investigation. Do not put keys, wallet seeds, card numbers, or private participant data in tools, prompts, logs, or handoff files.

No implementation, provider account creation, or fund movement was performed to prepare these handoffs.
