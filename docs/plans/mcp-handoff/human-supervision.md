# Human supervision: short grilling procedure

This is a standalone process for the teammate and their coding assistant. No skills, slash commands, or technical vocabulary are required.

## How the assistant should ask questions

- G1: Read the supplied decisions before asking. Do not reopen settled rules merely to fill a questionnaire.
- G2: Find technical facts yourself from SDK docs, code, and service contracts.
- G3: Ask only about a real choice that changes who can act, who can spend, project scope, custody, or irreversible behavior. Pick and log reversible engineering defaults.
- G4: Ask related independent questions together. If a question depends on an unanswered choice, wait until that choice is settled.
- G5: For each question, state a concrete example, the recommendation, and the consequence. Keep each question understandable without programming knowledge.
- G6: Record the answer as a decision. Separate confirmed answers, provisional defaults, and unresolved external facts.
- G7: Stop questioning when the remaining work can proceed under the documented rules. Lack of a production credential is not a reason to stop mock implementation.

Example:
```text
The connector is currently configured as Alice. If Bob connects,
should he be able to spend Alice's money?

Recommendation: no. We need a separate authenticated identity for Bob.
I can continue testing with isolated demo identities while the real
login method is connected.
```

## Your checkpoints

### Before implementation

Ask:
```text
In plain language, tell me what you are building, what the backend
will do instead, and which one AI app you will test first.
Show me any assumptions that could let the wrong person spend money.
```

Proceed when it describes an MCP connector, not a duplicated group-buy backend or payment processor. It should explicitly distinguish live integrations from mocks.

### Before connecting multiple people

Ask:
```text
Show me how the server knows which person is using it.
Show me Bob failing to accept Alice's price increase or close her buy.
```

Proceed only when identity comes from authentication/configured isolated demo credentials, not a name the model types.

### Before the demo

Ask:
```text
Show three people joining one merchant buy. Have one leave so the
remaining people's costs exceed their limits. Show the new approval
requests. Reject one, recalculate again, and keep payment blocked.
Then resolve the approvals and show the payment-service status.
```

Use the exact numerical fixture in acceptance-checks.md. The server, not just chat text, must show the state.

### Before declaring done

Ask:
```text
Run the same join or payment-triggering request twice.
Show that it does not double-join or double-pay.
Disconnect the AI app and show that deadlines still work.
Reconnect and retrieve missed updates.
Tell me exactly what is real, mocked, unsupported, or still blocked.
```

## Stop conditions

Stop the demo and ask the implementation owner if:
- S1: The assistant requests wallet seeds, raw card details, or secrets in chat.
- S2: A participant can approve another participant's amount.
- S3: A payment is called successful without authoritative service status.
- S4: Someone is charged above their approved amount, or a failed/unknown transfer is retried as a new payment.
- S5: The implementation promises background notifications in a host that cannot receive them.

This procedure supplements tests. Human supervision does not replace server-side authorization.
