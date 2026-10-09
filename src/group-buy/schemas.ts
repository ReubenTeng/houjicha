import { z } from "zod";

const text = (max = 200) => z.string().min(1).max(max);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const groupMoneySchema = z.strictObject({ currency: z.string().regex(/^[A-Z]{3}$/), minor: z.string().regex(/^(0|[1-9]\d{0,17})$/) });
const point = z.strictObject({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) });
const instant = z.iso.datetime({ offset: true });
const window = z.strictObject({ startsAt: instant, endsAt: instant, timeZone: text(100) });
const collection = z.strictObject({ point: point.extend({ label: text(300), address: z.string().max(1000) }), window });
const lines = z.array(z.strictObject({ variantId: text(200), quantity: z.number().int().min(1).max(1000000) })).min(1).max(20);
const constraints = z.strictObject({ maxTotal: groupMoneySchema, origin: point, maxDistanceMeters: z.number().finite().min(0), availabilityWindow: window });
const metadata = z.strictObject({ commandId: text(), expectedVersion: integer });
const basket = z.strictObject({ lines, constraints, authorizationRef: text() });
const create = basket.extend({ merchantId: text(), collection, joiningDeadline: instant, fulfillment: z.record(text(100), text(1000)).optional() });
export const groupInputSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("search_catalog"), query: z.string().trim().max(500), merchantId: text().optional(), cursor: text(300).optional() }),
  z.strictObject({ action: z.literal("find_group_buys"), merchantId: text(), lines, constraints }),
  z.strictObject({ action: z.literal("get_group_buy"), groupBuyId: text() }),
  z.strictObject({ action: z.literal("create_group_buy"), metadata, input: create }),
  z.strictObject({ action: z.literal("join_group_buy"), metadata, groupBuyId: text(), input: basket }),
  z.strictObject({ action: z.literal("leave_group_buy"), metadata, groupBuyId: text() }),
  z.strictObject({ action: z.literal("close_group_buy"), metadata, groupBuyId: text() }),
  z.strictObject({ action: z.literal("cancel_group_buy"), metadata, groupBuyId: text() }),
  z.strictObject({ action: z.literal("respond_to_price_change"), metadata, groupBuyId: text(), approvalRequestId: text(), decision: z.enum(["ACCEPT", "REJECT"]) }),
  z.strictObject({ action: z.literal("get_my_updates"), cursor: integer.optional(), limit: z.number().int().min(1).max(100).optional() }),
  z.strictObject({ action: z.literal("get_payment_status"), groupBuyId: text() }),
]);
export type GroupInput = z.infer<typeof groupInputSchema>;
export type GroupAction = GroupInput["action"];
export const capabilitiesSchema = z.strictObject({ catalog: z.boolean(), payments: z.boolean(), consent: z.boolean() });
const approval = z.strictObject({ id: text(), participantId: text(), orderRevision: integer, total: groupMoneySchema, state: z.enum(["PENDING", "ACCEPTED", "REJECTED", "OBSOLETE"]) });
const nextAction = z.strictObject({ actionId: text(), kind: z.enum(["FUNDING_SETUP", "CONTRIBUTION_APPROVAL", "MERCHANT_APPROVAL", "RECOVERY_REVIEW"]), targetUserId: text(), secureActionRef: text(8192) });
const outcome = z.strictObject({ participantId: text(), collection: z.enum(["PENDING", "SUCCEEDED", "FAILED", "UNKNOWN"]), refund: z.enum(["NONE", "PENDING", "SUCCEEDED", "FAILED", "UNKNOWN"]) });
const payment = z.strictObject({ submissionId: text(500), status: z.enum(["ACCEPTED", "COLLECTING", "ACTION_REQUIRED", "PAYING", "SUCCEEDED", "RECOVERING", "FAILED", "UNKNOWN"]), paymentOperationId: text(500).nullable(), ownOutcome: outcome.nullable(), nextActions: z.array(nextAction) }).nullable();
const charge = z.strictObject({ participantId: text(), merchantShare: groupMoneySchema, fundingFee: groupMoneySchema, totalDebit: groupMoneySchema, authorizationId: text() });
const authorization = z.strictObject({ authorizationId: text(), userId: text(), action: z.enum(["HOST", "JOIN"]), merchantId: text(), lines, constraints, collection, joiningDeadline: instant.optional() });
const group = z.strictObject({
  id: text(), merchantId: text(), organizerId: text(), collection, joiningDeadline: instant, version: integer, orderRevision: integer,
  status: z.enum(["OPEN", "FINALIZING", "COLLECTING", "PAYMENT_ACTION_REQUIRED", "PAYING", "RECOVERING", "COMPLETED", "FAILED", "CANCELLED"]),
  arrangementFixed: z.boolean(), participantCount: integer,
  ownParticipant: z.strictObject({ userId: text(), lines, constraints, authorization, allocation: charge.nullable() }).nullable(),
  approvals: z.array(approval), payment, quoteExpiresAt: instant.nullable(), blocker: z.string().nullable(),
});
const command = z.strictObject({ group, eventIds: z.array(text()) });
export const groupResultSchemas = {
  search_catalog: z.strictObject({ items: z.array(z.strictObject({ merchantId: text(), productId: text(), variantId: text(), title: z.string().max(1000), attributes: z.record(z.string(), z.string()), indicativePrice: groupMoneySchema, available: z.boolean() })), nextCursor: z.string().nullable() }),
  find_group_buys: z.array(z.strictObject({ group, distanceMeters: z.number(), estimatedTotal: groupMoneySchema, pricing: z.literal("INDICATIVE"), reasons: z.array(z.string()) })),
  get_group_buy: group,
  create_group_buy: command, join_group_buy: command, leave_group_buy: command, close_group_buy: command, cancel_group_buy: command, respond_to_price_change: command,
  get_my_updates: z.strictObject({ items: z.array(z.strictObject({ eventId: text(), type: text(), aggregateId: text(), sequence: integer, occurredAt: instant })), nextCursor: integer, pending: z.array(z.strictObject({ groupBuyId: text(), approvals: z.array(approval), nextActions: z.array(nextAction) })) }),
  get_payment_status: payment,
} satisfies Record<GroupAction, z.ZodType>;
export const groupOutputSchema = z.strictObject({
  ok: z.boolean(), mode: z.enum(["mock", "sandbox"]), simulated: z.boolean(), status: text(),
  data: z.union([
    z.strictObject({ action: z.enum(Object.keys(groupResultSchemas) as [GroupAction, ...GroupAction[]]), result: z.json(), capabilities: capabilitiesSchema, freshness: z.enum(["STORED", "INDICATIVE", "COMMAND_RESULT"]) }),
    z.strictObject({ currentVersion: integer }),
  ]).nullable(),
  next_action: z.strictObject({ type: text(), message: z.string().max(500) }).nullable(),
  error: z.strictObject({ code: text(), message: z.string().max(500), retryable: z.boolean(), trace_id: z.uuid() }).optional(),
});

export function groupScopes(input: GroupInput): string[] {
  if (["search_catalog", "find_group_buys", "get_group_buy", "get_my_updates", "get_payment_status"].includes(input.action)) return ["commerce:read"];
  return ["commerce:prepare", ...(["close_group_buy", "respond_to_price_change"].includes(input.action) ? ["commerce:checkout"] : [])];
}
