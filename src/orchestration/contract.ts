// Application contract v1. Amounts are exact nonnegative integer strings.
export type Money = { currency: string; minor: string };
export type Line = { variantId: string; quantity: number };
export type Point = { latitude: number; longitude: number };
export type Window = { startsAt: string; endsAt: string; timeZone: string };
export type Collection = { point: Point & { label: string; address: string }; window: Window };
export type Constraints = { maxTotal: Money; origin: Point; maxDistanceMeters: number; availabilityWindow: Window };
// Only an authentication adapter may construct this context, never tool arguments.
export type ActorContext = { userId: string };
export type Metadata = { commandId: string; expectedVersion: number };
export type BasketInput = { lines: Line[]; constraints: Constraints; authorizationRef: string };
export type CreateInput = BasketInput & { merchantId: string; collection: Collection; joiningDeadline: string; fulfillment?: Record<string, string> };
export type Mutation =
  | { operation: 'create'; metadata: Metadata; input: CreateInput }
  | { operation: 'join'; metadata: Metadata; groupBuyId: string; input: BasketInput }
  | { operation: 'leave' | 'close' | 'cancel'; metadata: Metadata; groupBuyId: string }
  | { operation: 'respond'; metadata: Metadata; groupBuyId: string; approvalRequestId: string; decision: 'ACCEPT' | 'REJECT' };
export type Status = 'OPEN' | 'FINALIZING' | 'COLLECTING' | 'PAYMENT_ACTION_REQUIRED' | 'PAYING' | 'RECOVERING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type ErrorCode = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'VALIDATION_ERROR' | 'VERSION_CONFLICT' | 'IDEMPOTENCY_CONFLICT' | 'GROUP_NOT_OPEN' | 'MEMBERSHIP_LOCKED' | 'CONSTRAINTS_NOT_MET' | 'APPROVAL_STALE' | 'QUOTE_EXPIRED' | 'ITEM_UNAVAILABLE' | 'PROVIDER_UNAVAILABLE' | 'PRICING_UNSUPPORTED';
export class DomainError extends Error {
  constructor(public readonly code: ErrorCode, public readonly retryable = false, public readonly currentVersion?: number) { super(code); }
}
export interface Clock { now(): string }
export interface Variant { merchantId: string; productId: string; variantId: string; title: string; attributes: Record<string, string>; indicativePrice: Money; available: boolean }
export interface CatalogPort {
  search(query: string, merchantId?: string, cursor?: string): Promise<{ items: Variant[]; nextCursor: string | null }>;
  get(variantId: string): Promise<Variant | null>;
}
export type OrderLine = Line & { participantId: string };
export type QuoteOrder = { groupBuyId: string; orderRevision: number; merchantId: string; currency: string; lines: OrderLine[]; collection: Collection; fulfillment?: Record<string, string> };
export type Quote = {
  quoteId: string; expiresAt: string; currency: string; evidence: 'VERIFIED_LINES' | 'AGGREGATE_ONLY';
  lines: (OrderLine & { amount: Money; available: boolean })[];
  sharedDelivery: Money; merchantTotal: Money; fundingFees: { participantId: string; amount: Money }[];
};
export type Charge = { participantId: string; merchantShare: Money; fundingFee: Money; totalDebit: Money; authorizationId: string };
export type PaymentSnapshot = QuoteOrder & { schemaVersion: '1'; organizerId: string; quoteId: string; quoteExpiresAt: string; merchantTotal: Money; participantCharges: Charge[] };
export type PaymentState = 'ACCEPTED' | 'COLLECTING' | 'ACTION_REQUIRED' | 'PAYING' | 'SUCCEEDED' | 'RECOVERING' | 'FAILED';
export type NextAction = { actionId: string; kind: 'FUNDING_SETUP' | 'CONTRIBUTION_APPROVAL' | 'MERCHANT_APPROVAL' | 'RECOVERY_REVIEW'; targetUserId: string; secureActionRef: string };
export type ParticipantOutcome = { participantId: string; collection: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN'; refund: 'NONE' | 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' };
export type PaymentStatus = { paymentOperationId: string; submissionId: string; orderRevision: number; sequence: number; state: PaymentState; unresolvedFunds: boolean; merchantStatus: 'NOT_STARTED' | 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN'; participantOutcomes: ParticipantOutcome[]; nextActions: NextAction[] };
export interface GroupPaymentPort {
  quoteGroupOrder(order: QuoteOrder): Promise<Quote>;
  // Must durably deduplicate submissionId AND groupBuyId/orderRevision before any money movement.
  startGroupPayment(snapshot: PaymentSnapshot, submissionId: string): Promise<PaymentStatus>;
  // Lookup by stable submissionId works even if the start response was lost.
  getGroupPayment(submissionId: string): Promise<PaymentStatus | null>;
  requestRecovery(submissionId: string, reason: string): Promise<PaymentStatus>;
}
export type Authorization = {
  authorizationId: string; userId: string; action: 'HOST' | 'JOIN'; merchantId: string;
  lines: Line[]; constraints: Constraints; collection: Collection; joiningDeadline?: string;
};
export interface AuthorizationPort {
  // Resolves a backend-recorded grant. Free text and model assertions are not grants.
  resolve(reference: string, actor: ActorContext): Promise<Authorization | null>;
}
export type Participant = { userId: string; lines: Line[]; constraints: Constraints; authorization: Authorization; allocation: Charge | null };
export type Approval = { id: string; participantId: string; orderRevision: number; total: Money; state: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'OBSOLETE' };
export type Group = {
  id: string; merchantId: string; organizerId: string; collection: Collection; joiningDeadline: string;
  fulfillment?: Record<string, string>; status: Status; version: number; orderRevision: number;
  eventSequence: number; arrangementFixed: boolean; participants: Participant[]; quote: Quote | null; approvals: Approval[];
  payment: { submissionId: string; snapshot: PaymentSnapshot; status: PaymentStatus | null; dispatched: boolean } | null;
  blocker: ErrorCode | null;
};
export type Event = { eventId: string; type: string; aggregateId: string; sequence: number; occurredAt: string; recipients: string[] };
export type GroupView = {
  id: string; merchantId: string; organizerId: string; collection: Collection; joiningDeadline: string;
  version: number; orderRevision: number; status: Status; arrangementFixed: boolean;
  participantCount: number; ownParticipant: Participant | null; approvals: Approval[];
  payment: { submissionId: string; status: PaymentState | 'UNKNOWN'; paymentOperationId: string | null; ownOutcome: ParticipantOutcome | null; nextActions: NextAction[] } | null;
  quoteExpiresAt: string | null; blocker: ErrorCode | null;
};
export type CommandResult = { group: GroupView; eventIds: string[] };
export type Discovery = { group: GroupView; distanceMeters: number; estimatedTotal: Money; pricing: 'INDICATIVE'; reasons: string[] };
