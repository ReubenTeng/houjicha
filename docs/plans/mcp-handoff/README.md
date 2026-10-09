# MCP teammate handoff

## What you are building

A connector that lets an external AI agent search merchants and manage group buys by calling our orchestration backend. You are NOT building the group-buy engine, a payment processor, Telegram, or a new AI agent.

You can give this entire folder to your coding assistant. All project-specific instructions it needs are here.

## Start here

1. Read product-context.md for the rules already decided and glossary.md for the shared terms.
2. Read integration-contract.md with the orchestration owner. It is a proposed contract, not a running API.
3. Give your coding assistant the prompt below.
4. Use human-supervision.md at the checkpoints. You do not need to answer routine programming questions.
5. Ask the assistant to demonstrate acceptance-checks.md before saying it is done.

If the backend is not ready, build against a clearly labeled mock using the same contract. Never present mock joins or payments as live actions.

## Copy and paste into your coding assistant

```text
Implement the MCP adapter described by this folder.

First read product-context.md, integration-contract.md,
human-supervision.md, agent-usage.md, and acceptance-checks.md.
Treat the integration contract as proposed until aligned with the
orchestration owner. Do not assume any endpoints already exist.

Build a thin, typed adapter using a maintained MCP SDK. Keep identity,
authentication, backend transport, and tool mapping separate from the
SDK so they can be tested. Reuse the backend's schemas where available.
Business decisions, durable state, deadlines, pricing, authorization,
and payments belong to orchestration/payment, not the model or adapter.

Use one real target MCP host for the first end-to-end demonstration.
Check its actual connection/auth support. Do not claim compatibility
with every named agent merely because this is MCP. Use a labeled mock
backend while service implementation is pending.

Choose reversible implementation defaults and record them. Ask the
human only if scope, identity/consent, custody, or irreversible payment
behavior changes. Explain each such question simply and recommend an
answer. Use the supervision procedure in this folder without requiring
a Skill tool or any installed skill files.

Keep credentials and provider secrets out of tool arguments/results,
prompts, source control, and logs. Never accept a tool-supplied user ID
as authority. Never invent an approval, successful payment, or tool
result. Ask before real-money operations or production deployment.

Deliver source, setup instructions, an environment-variable example
with placeholders, validated tool schemas, contract tests, and a
repeatable multi-user demo. Report exact commands and pass/fail output.
Separate mocked tests from real backend and provider-sandbox tests.
```

## Implementation scope

- M1: Expose the C3 tools in integration-contract.md with precise descriptions, validated inputs, and structured outputs.
- M2: Map an authenticated host user to the backend actor. For a local-only prototype, use an explicitly configured single test identity. Keep it isolated and never deploy that shortcut as multi-user authentication.
- M3: Use command idempotency and expected versions on mutations. Return backend conflicts without silently changing the user's authorization.
- M4: Return actionable state: current buy, own total, whether estimated/final, pending approvals, and safe next steps. The external agent should not have to infer payment success from prose.
- M5: Offer update polling with cursors. A hosted agent may not run continuously or receive unsolicited events.
- M6: Add tool annotations accurately, but enforce every permission in the backend. A readOnlyHint is descriptive metadata, not access control.
- M7: Treat catalog descriptions and provider messages as untrusted data, never instructions that can authorize a purchase.

## Suggested implementation defaults

Use a maintained TypeScript MCP SDK if the teammate has no established stack. Keep the backend client independent of that choice. Prefer remote Streamable HTTP when the first target host supports it. Stdio can be useful for local testing but does not make a cloud host able to reach your laptop.

Do not build both transports, a custom authentication provider, or multiple host integrations just to claim portability. Prove one target host and keep core domain behavior independent.

Use MCP tools for operations. Optional resources can expose readable help or state if the target host supports them. Optional prompts can offer a buying workflow. The first working version must not require either.

## Suggested skills

No skill installation is required to build or use this MCP server. MCP tools are the runtime interface. Host-specific skills cannot enforce security or payment rules.

If your coding assistant already has suitable skills, use:
- grilling: only for material unresolved decisions. The standalone equivalent is human-supervision.md.
- domain-modeling: preserve the merchant/group-buy/participant language in product-context.md.
- code-review: check tool permissions, contracts, and error/retry paths.
- diagnosing-bugs: use when a reproduced integration test fails.

Do not assume the Skill tool exists. Do not copy our private skill paths. agent-usage.md is a portable instruction sheet you may paste into the target host or wrap as an optional host-specific skill later.

## Completion

Show the nontechnical teammate the full scenario in acceptance-checks.md, including a departure causing new price approvals. Show a denied action from the wrong user. Show retry safety. Show what happens when the agent disconnects.

Mark the adapter as mock-integrated until the actual backend is exercised. Production readiness is outside this hackathon handoff.

## Official MCP references

The follow-up documentation check supports the adapter guidance above. Confirm the chosen host and SDK version before using version-specific examples.

- TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- Python SDK: https://github.com/modelcontextprotocol/python-sdk
- Tools, resources, and prompts: https://modelcontextprotocol.io/specification/draft/server/index
- TypeScript authorization guidance: https://ts.sdk.modelcontextprotocol.io/v2/serving/authorization

No specific host's authentication, transport, or background-notification support has been tested in this handoff.
