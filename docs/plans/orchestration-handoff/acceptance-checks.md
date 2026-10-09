# Required acceptance evidence

These expected outcomes come from the agreed rules and named provisional defaults in product-context.md. All monetary fixtures below are synthetic USD minor units with verified line attribution, not Reap observations.

## T1: Approval cascade and stale response

Alice, Bob and Cara each order one 900-unit item. Delivery is 600. Each authorizes 1150.

1. Three participants owe 1100 each.
2. Bob leaves before collection. Alice and Cara owe 1200 each. Both need explicit approval, and payment is blocked.
3. Alice accepts 1200. Cara rejects and is removed.
4. Alice now owes 1500. Her earlier acceptance does not authorize this increase. A new request is pending.
5. Replaying the obsolete approval fails without changing the active authorization.
6. Alice accepts 1500. A valid final quote and closed buy permit exactly one immutable payment submission.
7. Payment pending does not mark the buy completed. A confirmed successful service outcome does.

Repeat with rejection arriving before Alice's first response. That response must be recognized as stale rather than authorizing 1500.

## T2: Matching and fixed arrangement

Use two eligible buys at different distances and one nearer ineligible buy. Filter the ineligible buy, rank the rest by distance then collection window. An exact variant from the same merchant can be added even if nobody ordered it yet. Reject a different merchant, unavailable variant, incompatible collection window or excessive distance.

Creation needs separate organizer opt-in. Joining as a second participant permanently fixes collection details, even if that participant later leaves.

## T3: Race and idempotency

Run simultaneous join and close commands. Exactly one serialized order is observed, never a paid snapshot missing a committed participant.

Retry the same command after restart: original result, no duplicate effect. Changed payload under the same key conflicts. Race two finalization workers: one payment operation. A leave racing collection lock either changes the finalized revision before lock or is rejected.

## T4: Pricing integrity

For Alice/Bob/Cara in stable ID order, split a 601-unit delivery fee as 201/200/200. Participant shares sum exactly to the quote.

Reject mixed currencies, malformed amounts, unsupported precision, inconsistent provider totals, unavailable items and aggregate-only item evidence for heterogeneous baskets. Do not label catalog prices as final. Quote expiry/repricing invalidates stale approval requests and prohibits dispatch using expired terms.

A quote within existing genuine authorization does not require a new participant click solely because it is final. Reap-required hosted approval remains independent.

## T5: Financial uncertainty

Fake Alice and Bob's contributions succeeding and Cara's failing. The buy enters recovery with no reduced merchant order. Do not unlock membership until the payment service confirms no unresolved funds.

Fake timeout after submission followed by late success. No second payment or premature refund. Duplicate/out-of-order events cannot regress state. A failed refund leaves recovery visible, not a terminal clean failure.

## T6: Identity and privacy

Bob cannot approve Alice's amount, close Alice's buy or obtain her private funding action. Reject identity spoofing in untrusted command inputs. Redact private provider data and prevent catalog text from changing authority or triggering actions.

## T7: Offline and restart

Disconnect all clients before the joining deadline. A durable worker still closes/finalizes as appropriate. Restart between persisting payment intent and dispatch, and between dispatch and acknowledgment. Reconcile one operation using its stable identity. Reconnect and retrieve missed updates with a cursor.

## Evidence to hand back

- E1: Exact commands and passing/failing output for existing checks and the new explicit fixtures.
- E2: One repeatable script using at least three distinct authenticated demo actors, real persistence, a restart and an approval cascade. The payment service may be a labeled fault-injecting fake.
- E3: Sanitized group versions, financial revisions, allocations, approval IDs, payment operation ID and events demonstrating each transition.
- E4: A limitations list separating core proof, MCP integration, real payment-service integration and provider sandbox proof. Passing fakes never proves actual participant funds moved.

No application tests were executed in preparing this document-only handoff.
