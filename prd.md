# ShipFund — Hackathon PRD

**Tagline:** Give your coding agent a budget, not your credit card.

**Status:** Build-ready proposal, with payment integration gated on sandbox access  
**Team:** 3 engineers, 1 designer  
**Timebox:** 5 hours  
**Version:** 1.0 · 9 October 2026

## 1. Product summary

ShipFund lets a coding agent acquire a paid developer resource within a spending mandate set by a human. It validates a resource request, authorizes the purchase, provisions access, and returns a usable resource reference so the agent can continue working.

The hackathon prototype supports one resource: image-capable AI inference. A coding agent completing a scaffolded image-caption application requests access through a CLI. ShipFund applies the project's budget policy, executes a sandbox or explicitly simulated payment, provisions a limited API key from an existing funded account, and enables the app to generate a real caption and accessible alt text.

The core demonstration is causal: **feature blocked → agent requests access → policy permits purchase → resource provisioned → feature works**.

## 2. Problem and target user

Coding agents can implement software but frequently require human intervention to acquire paid dependencies. Developers must interrupt their workflow to configure billing, obtain credentials, and reconnect the agent.

The initial user is a developer using a terminal-capable coding agent to complete a small application. The developer wants to delegate a bounded purchase without providing unrestricted financial credentials.

**Job to be done:** “When my agent needs a paid resource to finish a feature, let it obtain usable access within my rules and continue without another manual setup step.”

## 3. Goals and success criteria

The prototype must demonstrate:

1. A real coding agent invokes the procurement CLI without a human completing the purchase manually.
2. Server-side policy authorizes a permitted request and blocks a prohibited request before contacting the payment adapter.
3. An authorized acquisition provisions working inference access and unlocks the demo application's feature.
4. Repeating the same procurement request does not create another charge or resource.
5. The interface accurately reports payment mode, budget commitment, provisioning status, and outcome.

**Demo acceptance:** Run the permitted acquisition and blocked-request sequence twice from a reset project without code changes. Capture one successful rehearsal as a backup video.

No production-readiness, arbitrary application-generation, or real merchant credit-purchase claim is required for success.

## 4. Scope

### Must ship

- One demo project with a configurable budget and per-purchase limit.
- One allowed resource category: `image-inference`.
- Two fixed packages in a server-owned catalog, sufficient to demonstrate an allowed and denied purchase.
- One procurement CLI integration for a terminal-capable coding agent.
- A deterministic policy check and persistent purchase ledger.
- One payment adapter: Reap sandbox when feasible, otherwise an explicitly simulated adapter.
- Real inference-key provisioning from a preconfigured, funded OpenRouter account.
- A scaffolded image-caption app using a backend inference route.
- One project screen showing budget, events, resource status, and the demo app.
- Duplicate protection, a denied-request path, and a failed-payment path.
- A repeatable demo reset that revokes the previous demo key before creating a new project.

### Out of scope

- SaaS signup, CAPTCHA, email verification, or browser checkout automation.
- Direct purchase of OpenRouter credits unless separately verified and implemented.
- Hosting, database, storage, domain, or subscription procurement.
- Recurring billing, refunds, cancellation workflows, currency conversion, and tax handling.
- General provider discovery, live price comparison, or negotiated quotes.
- Human approval queues; requests outside policy are denied in this version.
- Multi-user onboarding, production authentication, and a public purchasing API.
- Arbitrary prompt-to-production app generation, multiple agent integrations, or a separate procurement LLM.

## 5. Demo scenario and pricing semantics

**User instruction:** “Finish this image-caption app. You have a $10 project budget, with a maximum autonomous purchase of $5.”

The agent completes a small real change in a prepared scaffold, discovers that inference access is missing, invokes the procurement CLI, and verifies the feature after access is enabled.

The controlled demo catalog contains:

- `starter`: $5 sandbox purchase amount; provisions a key with a $1 non-resetting inference allowance.
- `extended`: $8 sandbox purchase amount; would provision a key with a $2 non-resetting inference allowance, but is denied under the default $5 transaction limit.

These are **illustrative storefront prices**, not quoted OpenRouter retail packages. The $1 and $2 inference allowances draw on an already funded team account. They are separate from the sandbox purchase amounts and must be described that way.

The screen distinguishes:

- **Project budget:** spending authority delegated to the agent.
- **Reserved:** pending purchases holding part of that authority.
- **Purchased:** confirmed demo purchase amounts.
- **Available:** budget minus reserved and purchased amounts.
- **Inference allowance:** the maximum provider usage allocated to the resource.
- **Actual inference usage:** display only if retrieved from the provider; otherwise omit it.

For the default successful purchase, purchased is $5 and available is $5. Actual provider usage must never be presented as $5 merely because the package price is $5.

## 6. User flow

1. The developer opens the project screen and sets a $10 budget and $5 transaction limit.
2. The image-caption feature reports that inference access is required.
3. The coding agent requests `starter` access through the CLI, including a reason and stable request ID.
4. ShipFund looks up the package, validates the request, and checks policy.
