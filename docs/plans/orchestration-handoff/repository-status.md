# Repository status and contract reconciliation

Observed at commit 9ab628b, branch main, with a clean working tree. Recheck before starting.

## Existing assets

- E1: package.json uses Node.js >=22, TypeScript, tsx, Vitest and grammY. src/telegram/ contains a small /start and /tester bot plus tests. Keep it working, but do not couple orchestration to it.
- E2: docs/plans/mcp-handoff/ and docs/plans/payment-service-handoff/ contain the teammate packages. Their product-context.md and integration-contract.md carry the MCP-first rules.
- E3: docs/reap-wrapper-contract.ts defines a documented, injected TypeScript ReapWrapper. docs/reap-wrapper-api.md describes it. This is not evidence of a working provider integration.
- E4: scripts/ and package scripts generate/check the wrapper reference. Preserve this existing workflow.
- E5: prd.md is a different ShipFund paid-inference proposal. It is not the group-buy specification. Do not implement its procurement CLI, inference provisioning, or single-user budget model for this task.
- E6: No group-buy core was found under src/ at this baseline. Earlier conversation referred to GLOSSARY.md and docs/plans/group-buy-orchestration.md, but those are absent from this checkout. Use the bundled context/glossary instead.

## Conflicts to resolve at integration, not by guessing

### C1: Payment-service ownership and operation level

Our latest agreement: payment service collects participant shares, places the merchant order, reconciles and refunds. Orchestration sends an authorized immutable snapshot.

The older Reap wrapper document puts local wallet holds, checkout calls and per-participant debit scheduling in orchestration. It purchases first, then debits participant credits. This differs from the provisional collect-first flow and can leave a paid merchant order with unpaid participants.

Recommendation: consume a high-level GroupPaymentPort in our core. Payment teammate may compose the low-level ReapWrapper inside their component. It need not be a separately deployed service. Do not call createCheckout/debitWallet directly from our group lifecycle merely because those signatures exist. A switch to buy-first or credit subsidy needs explicit agreement.

### C2: Money representation

The shared handoff proposal uses JSON numeric minor units. Existing ReapWrapper uses integer strings.

Recommendation for implementation: use integer strings at our serialized service boundaries, matching the existing typed contract. Validate decimal-integer syntax, nonnegative charge amounts, currency and range. Use exact integer arithmetic internally. The shared examples remain an unmodified historical proposal until both teammates accept the revised schema. Do not silently change the MCP wire shape or accept lossy number conversions.

This is a reversible serialization decision, not permission to change a person's authorized total.

### C3: Verified item prices

The proposed payment handoff expects an item-level quote breakdown. The existing wrapper correctly represents AGGREGATE_ONLY versus VERIFIED_LINES and warns that catalog prices are not final line prices.

Recommendation: model quote price-evidence quality. Real final allocation of heterogeneous baskets blocks without verified per-line attribution or an explicitly agreed alternative policy. Core tests may use labeled fixtures with verified lines. Do not invent final line prices from a matching subtotal.

### C4: Enrollment and provider support

Our earlier research found guide examples for Reap-card enrollment. The newer wrapper document reports that endpoint references mark some sources as coming soon.

Recommendation: payment teammate resolves actual project capabilities. Core consumes normalized availability/next actions and does not hardcode enrollment source, chain, token, wallet funding mode, or a 300-unit allowance. A documentation example is not a verified capability.

### C5: Participant approval rules

Some older wrapper prose demands explicit final approval from everyone. The agreed product permits autonomous joining/purchase within existing user-authorized limits, with explicit accept/reject only when authorization is exceeded or terms fall outside its scope.

Recommendation: always validate the final quote against each participant's recorded authorization. Require a new response when needed, not a new click from everyone by default. Provider-required hosted approval is a separate step and may still require human action.

### C6: Collection point versus delivery address

The original product fixes where participants collect. Reap quoting may need a complete merchant shipping address.

Recommendation: store organizer fulfillment details separately when needed, linked to the confirmed collection arrangement. A map coordinate alone is not a deliverable address. Missing required shipping input blocks quoting, not basic group discovery. Never invent an address or expose a private address beyond its intended audience.

## Decisions for this handoff

- D1: Preserve the existing TypeScript stack rather than introducing a Go service just because the general new-project defaults mention Go.
- D2: Use domain/application ports that can be injected directly or wrapped by HTTP. No separate deployment or broker is required to preserve implementation independence.
- D3: Keep source conflicts explicit. Do not rewrite teammates' existing docs in this handoff task.
- D4: Build against contract fakes while capabilities/field mappings are aligned. This is not a claim of provider integration.
- D5: Store this continuation handoff in a temporary shareable folder, leaving the repository untouched.
