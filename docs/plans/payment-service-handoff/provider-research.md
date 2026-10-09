# Reap participant wallets and group payments

## Findings

### F1: Multiple users and wallets are documented

Reap supports creating users with `POST /users` and accounts with `POST /accounts`. Accounts require approved owner verification. Sandbox user-verification simulation is documented.

In a `USER_FUNDED` project, each account has deposit addresses on enabled chains and an isolated balance. Account creation requires proof of ownership of a signer key for each enabled chain family. Cards spend against their owning account.

In a `PROGRAM_FUNDED` project, users do not have individual deposit addresses. One master collateral account backs the program. In Managed authorization mode, virtual asset postings allocate individual spending balances. The funding model is configured by Reap, not chosen per API call.

Sources:
- https://docs.reap.global/quickstart.md
- https://docs.reap.global/api-reference/accounts/create-account.md
- https://docs.reap.global/api-reference/simulation/simulate-user-application-status.md
- https://docs.reap.global/program-configuration/funding-models.md
- https://docs.reap.global/accounts/overview.md

### F2: Sandbox token funding is documented; 300 USDC is unverified

Sandbox deposits use actual testnet transfers of Reap test tokens such as RUSDC. Reap instructs developers to contact their representative for test funding. No reviewed official source confirms a standard 300-USDC allowance or this team's balance.

Read accepted assets from the particular account. Token contract and chain must both match. Only an approved deposit counts toward available funds, not merely an on-chain confirmed deposit.

An illustrative allocation of 100 test units to each of three participants is feasible only after confirming this team's funding model, available balance, supported token, chain, and any fees. It is not a verified allocation.

Sources:
- https://docs.reap.global/accounts/deposits.md
- https://docs.reap.global/accounts/supported-assets.md

### F3: Withdrawals provide a possible collection mechanism

User-Funded wallets support signed withdrawals to a specified address. Reap reserves funds, requests the registered signer's signature, broadcasts the transfer, and reports completion through status reads and webhooks. The signer can be held by the backend or the end user, with materially different custody and consent implications.

The documented fees are USD 0.30 on Base/Polygon and USD 0.75 on Solana, with a USD 5 minimum withdrawal. The requested amount is gross: the destination receives the amount after the fee. Query the current account assets before calculating amounts.

A candidate group-buy flow is participant withdrawals into the account funding the combined merchant purchase, followed by one Agentic checkout. This is a composition of documented primitives, NOT a documented native group-payment operation or a tested end-to-end integration. Confirm that Reap permits this use, that transfers between the relevant accounts are accepted, and that the issued card can be enrolled for this project.

If some contributions arrive and others fail, or checkout fails after collection, refunds require a separate recovery process. Transfers are not atomic across participants. An unknown checkout outcome must not trigger another purchase or premature refunds.

Source:
- https://docs.reap.global/accounts/withdrawals.md

### F4: Agentic checkout remains single-enrollment

The checkout request contains one `quoteId` and one `enrollmentId`, not a list of participant contributions. The setup guide shows `source: REAP_CARD` with a `cardId`, but the reviewed create-enrollment endpoint marks `REAP_CARD` and `BIN_SPONSOR` as coming soon. This matches the earlier wrapper review: neither source is verified available for this project. A schema branch or setup example is not evidence of enablement. The documented EXTERNAL hosted flow does not itself establish a wallet-backed purchaser card.

Multiple wallets do not prove native split payment. Creating one checkout per participant is not an established substitute for a single group merchant order.

The standard Agentic test cards never move money. Verify whether this team's wallet-backed sandbox checkout actually changes account balances; a simulated merchant order result alone does not prove participants were debited.

Sources:
- https://docs.reap.global/api-reference/agentic/create-checkout.md
- https://docs.reap.global/agentic-payments/setup.md

The earlier wrapper's virtual `WITHDRAWAL` records a Program-Funded virtual-credit debit; it does not transfer crypto or reimburse an external-card purchaser. `SETTLEMENT` also reduces that account's card debt and is not a generic group contribution operation. Neither can be substituted for the candidate collection flow without a separately verified money model.

The reviewed Agentic quote returns aggregate item subtotal and a total breakdown, not verified checkout line prices. The C4 requirement for exact participant item attribution must therefore remain blocked when item-level evidence is missing, unless a separately approved allocation policy is adopted. Do not fill the gap with catalog prices labeled final.

Sources for these constraints:
- https://docs.reap.global/api-reference/agentic/create-enrollment
- https://docs.reap.global/api-reference/agentic/create-quote
- https://docs.reap.global/api-reference/virtual-asset-postings/create-posting

### F5: Kwal also supports separate participants, but split checkout is not documented

Kwal's public skill documents distinct participant registrations with separate owner wallet addresses and credential files. Each participant provisions a vault and sandbox card, funds the vault with test USDC on Ink Sepolia, and checks out against that participant's vault with user approval.

The reviewed references do not document pooling participant vaults, inter-vault transfers, or splitting a single merchant checkout across wallets. They also do not verify the reported 300-USDC allocation. Kwal therefore does not remove the need to confirm a collection mechanism for a combined group purchase.

Sources:
- https://github.com/payward/kwal-skill/blob/main/skills/agent-payment/references/setup.md
- https://github.com/payward/kwal-skill/blob/main/skills/agent-payment/references/vault-and-funds.md
- https://github.com/payward/kwal-skill/blob/main/skills/agent-payment/references/funding.md
- https://github.com/payward/kwal-skill/blob/main/skills/agent-payment/references/checkout.md

## Required project-specific confirmation

1. Is the team configured as User-Funded or Program-Funded, and which APIs are enabled?
2. Where are the approximately 300 units held, on which chain, and are they RUSDC or another test asset?
3. Can participant accounts transfer approved contributions into the account funding one Agentic purchase, and what fees apply?
4. Does checkout against the resulting Reap-issued card affect sandbox account balances, or only return a simulated purchase result?

No users, wallets, cards, enrollments, or transfers were created during this research.
