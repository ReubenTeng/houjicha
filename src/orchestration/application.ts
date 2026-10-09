import { randomUUID } from 'node:crypto';
import { DomainError } from './contract.js';
import type { ActorContext, Approval, Authorization, AuthorizationPort, BasketInput, CatalogPort, Clock, CommandResult, CreateInput, Discovery, Event, Group, GroupPaymentPort, GroupView, Mutation, PaymentSnapshot, PaymentStatus, QuoteOrder } from './contract.js';
import type { Store } from './store.js';
import { allocate, amount, canonical, constraintsValid, distance, fingerprint, fits, instant, linesValid, money, pointValid, requireRule, windowValid } from './rules.js';

const mutable = (g: Group): boolean => g.status === 'OPEN' || g.status === 'FINALIZING';
export class Orchestration {
  constructor(private readonly store: Store, private readonly catalog: CatalogPort, private readonly payments: GroupPaymentPort, private readonly authorizations: AuthorizationPort, private readonly clock: Clock) {}
  private actor(actor: ActorContext): void { requireRule(actor && typeof actor.userId === 'string' && actor.userId.length > 0, 'UNAUTHENTICATED'); }
  private group(id: string): Group { const group = this.store.read(id); requireRule(group, 'NOT_FOUND'); return group; }
  private view(g: Group, actor: ActorContext): GroupView {
    const own = g.participants.find(p => p.userId === actor.userId) ?? null;
    return structuredClone({ id: g.id, merchantId: g.merchantId, organizerId: g.organizerId,
      collection: own || actor.userId === g.organizerId ? g.collection : { ...g.collection, point: { ...g.collection.point, address: '' } },
      joiningDeadline: g.joiningDeadline, version: g.version, orderRevision: g.orderRevision, status: g.status,
      arrangementFixed: g.arrangementFixed, participantCount: g.participants.length, ownParticipant: own,
      approvals: g.approvals.filter(a => a.participantId === actor.userId),
      payment: g.payment ? { submissionId: g.payment.submissionId, status: g.payment.status?.state ?? 'UNKNOWN', paymentOperationId: g.payment.status?.paymentOperationId ?? null, ownOutcome: g.payment.status?.participantOutcomes.find(p=>p.participantId===actor.userId) ?? null, nextActions: (g.payment.status?.nextActions ?? []).filter(a => a.targetUserId === actor.userId) } : null,
      quoteExpiresAt: g.quote?.expiresAt ?? null, blocker: g.blocker });
  }
  getGroupBuy(actor: ActorContext, id: string): GroupView { this.actor(actor); return this.view(this.group(id), actor); }
  getPaymentStatus(actor: ActorContext, id: string): GroupView['payment'] {
    this.actor(actor); const g = this.group(id);
    requireRule(g.participants.some(p => p.userId === actor.userId) || g.organizerId === actor.userId, 'FORBIDDEN');
    return this.view(g,actor).payment;
  }
  getMyUpdates(actor: ActorContext, cursor = 0, limit = 50): { items: Omit<Event, 'recipients'>[]; nextCursor: number; pending: { groupBuyId: string; approvals: Approval[]; nextActions: NonNullable<GroupView['payment']>['nextActions'] }[] } {
    this.actor(actor); requireRule(Number.isSafeInteger(cursor) && cursor >= 0 && Number.isInteger(limit) && limit > 0 && limit <= 100);
    const page = this.store.updates(actor.userId,cursor,limit);
    return { items: page.items.map(({recipients: _recipients,...event}) => event), nextCursor: page.nextCursor,
      pending: this.store.groups().filter(g => g.participants.some(p => p.userId === actor.userId)).map(g => { const v = this.view(g,actor); return { groupBuyId:g.id, approvals:v.approvals.filter(a=>a.state==='PENDING'), nextActions:v.payment?.nextActions ?? [] }; }).filter(p=>p.approvals.length || p.nextActions.length) };
  }
  async searchCatalog(actor: ActorContext, query: string, merchantId?: string, cursor?: string) {
    this.actor(actor); requireRule(typeof query === 'string' && query.length <= 500);
    return this.catalog.search(query, merchantId, cursor);
  }
  private async basket(input: BasketInput, merchantId: string): Promise<void> {
    linesValid(input.lines); constraintsValid(input.constraints);
    for (const line of input.lines) {
      const variant = await this.catalog.get(line.variantId);
      requireRule(variant && variant.merchantId === merchantId, 'CONSTRAINTS_NOT_MET');
      requireRule(variant.available, 'ITEM_UNAVAILABLE');
      amount(variant.indicativePrice,input.constraints.maxTotal.currency);
    }
  }
  async findGroupBuys(actor: ActorContext, merchantId: string, input: Pick<BasketInput,'lines'|'constraints'>): Promise<Discovery[]> {
    this.actor(actor); await this.basket({ ...input, authorizationRef: '' }, merchantId);
    const results: Discovery[] = [];
    for (const g of this.store.groups()) {
      if (g.merchantId !== merchantId || g.status !== 'OPEN' || instant(g.joiningDeadline) <= instant(this.clock.now()) || !fits(g.collection,input.constraints) || g.participants.some(p=>p.userId===actor.userId)) continue;
      const prospective = structuredClone(g);
      prospective.participants.push({ userId: actor.userId, lines: input.lines, constraints: input.constraints, authorization: {} as Authorization, allocation: null });
      try {
        const quote = await this.payments.quoteGroupOrder(this.order(prospective));
        const charge = allocate(prospective,quote,this.clock.now()).find(c=>c.participantId===actor.userId)!;
        if (amount(charge.totalDebit) > amount(input.constraints.maxTotal,charge.totalDebit.currency)) continue;
        results.push({ group: this.view(g,actor), distanceMeters: distance(g.collection.point,input.constraints.origin), estimatedTotal: charge.totalDebit, pricing:'INDICATIVE', reasons:['Exact variants available','Within spending and collection constraints','Straight-line distance, not a travel route'] });
      } catch (error) { if (!(error instanceof DomainError)) throw new DomainError('PROVIDER_UNAVAILABLE',true); }
    }
    return results.sort((a,b)=>a.distanceMeters-b.distanceMeters || instant(a.group.collection.window.startsAt)-instant(b.group.collection.window.startsAt) || a.group.id.localeCompare(b.group.id)).slice(0,3);
  }
  private order(g: Group): QuoteOrder {
    return { groupBuyId:g.id, orderRevision:g.orderRevision, merchantId:g.merchantId, currency:g.participants[0]!.constraints.maxTotal.currency,
      lines:g.participants.flatMap(p=>p.lines.map(l=>({...l,participantId:p.userId}))), collection:g.collection, ...(g.fulfillment ? {fulfillment:g.fulfillment} : {}) };
  }
  private event(g: Group, events: Event[], type: string, recipients = g.participants.map(p=>p.userId)): void {
    g.eventSequence++;
    events.push({eventId:randomUUID(),type,aggregateId:g.id,sequence:g.eventSequence,occurredAt:this.clock.now(),recipients:[...new Set([...recipients,g.organizerId])]});
  }
  private async grant(actor: ActorContext, input: BasketInput, g: Group, action: 'HOST'|'JOIN'): Promise<Authorization> {
    const grant = await this.authorizations.resolve(input.authorizationRef,actor);
    requireRule(grant && grant.userId === actor.userId && grant.action === action && grant.merchantId === g.merchantId && canonical(grant.lines) === canonical(input.lines) && canonical(grant.constraints) === canonical(input.constraints) && canonical(grant.collection) === canonical(g.collection) && (action !== 'HOST' || grant.joiningDeadline === g.joiningDeadline), 'FORBIDDEN');
    requireRule(typeof grant.authorizationId === 'string' && grant.authorizationId.length > 0,'FORBIDDEN');
    return structuredClone(grant);
  }
  private async reprice(g: Group, events: Event[]): Promise<void> {
    g.orderRevision++;
    for (const a of g.approvals) if (a.state === 'PENDING' || a.state === 'ACCEPTED') a.state='OBSOLETE';
    g.quote=null; g.blocker=null;
    for (const p of g.participants) p.allocation=null;
    if (!g.participants.length) { g.status='CANCELLED'; this.event(g,events,'group.cancelled'); return; }
    try {
      const quote = await this.payments.quoteGroupOrder(this.order(g));
      requireRule(typeof quote.quoteId === 'string' && quote.quoteId.length > 0);
      const charges = allocate(g,quote,this.clock.now());
      g.quote=structuredClone(quote);
      for (const p of g.participants) {
        p.allocation=charges.find(c=>c.participantId===p.userId)!;
        if (amount(p.allocation.totalDebit) > amount(p.authorization.constraints.maxTotal,p.allocation.totalDebit.currency)) {
          const approval: Approval = {id:randomUUID(),participantId:p.userId,orderRevision:g.orderRevision,total:p.allocation.totalDebit,state:'PENDING'};
          g.approvals.push(approval); this.event(g,events,'approval.required',[p.userId]);
        }
      }
    } catch (error) {
      g.blocker=error instanceof DomainError ? error.code : 'PROVIDER_UNAVAILABLE';
      this.event(g,events,'quote.blocked');
    }
  }
  private validateCommand(command: Mutation): void {
    requireRule(command && typeof command === 'object');
    const allowed = command.operation==='create' ? ['operation','metadata','input'] : command.operation==='join' ? ['operation','metadata','groupBuyId','input'] : command.operation==='respond' ? ['operation','metadata','groupBuyId','approvalRequestId','decision'] : ['operation','metadata','groupBuyId'];
    requireRule(['create','join','leave','close','cancel','respond'].includes(command.operation) && Object.keys(command).every(k=>allowed.includes(k)));
    requireRule(command.metadata && Object.keys(command.metadata).every(k=>['commandId','expectedVersion'].includes(k)) && typeof command.metadata.commandId==='string' && command.metadata.commandId.length>0 && command.metadata.commandId.length<=200 && Number.isSafeInteger(command.metadata.expectedVersion) && command.metadata.expectedVersion>=0);
    if (command.operation==='create' || command.operation==='join') {
      const allowedInput = command.operation==='create' ? ['merchantId','lines','constraints','authorizationRef','collection','joiningDeadline','fulfillment'] : ['lines','constraints','authorizationRef'];
      requireRule(command.input && Object.keys(command.input).every(k=>allowedInput.includes(k)));
    }
  }
  async execute(actor: ActorContext, command: Mutation): Promise<CommandResult> {
    this.actor(actor); this.validateCommand(command);
    const key=canonical([actor.userId,command.operation,command.metadata.commandId]); const hash=fingerprint(command);
    const prior=this.store.command(key,hash); if (prior) return prior;
    try {
    let g: Group;
    if (command.operation==='create') {
      const input: CreateInput=command.input;
      requireRule(command.metadata.expectedVersion===0 && typeof input.merchantId==='string' && input.merchantId.length>0);
      requireRule(input.collection && typeof input.collection.point?.label==='string' && input.collection.point.label.length>0 && typeof input.collection.point.address==='string' && input.collection.point.address.length>0);
      pointValid(input.collection.point); windowValid(input.collection.window);
      requireRule(instant(input.joiningDeadline)>instant(this.clock.now()) && instant(input.joiningDeadline)<instant(input.collection.window.startsAt));
      g={id:randomUUID(),merchantId:input.merchantId,organizerId:actor.userId,collection:structuredClone(input.collection),joiningDeadline:input.joiningDeadline,status:'OPEN',version:0,orderRevision:0,eventSequence:0,arrangementFixed:false,participants:[],quote:null,approvals:[],payment:null,blocker:null,...(input.fulfillment?{fulfillment:structuredClone(input.fulfillment)}:{})};
      await this.basket(input,g.merchantId); requireRule(fits(g.collection,input.constraints),'CONSTRAINTS_NOT_MET');
      const authorization=await this.grant(actor,input,g,'HOST');
      g.participants.push({userId:actor.userId,lines:structuredClone(input.lines),constraints:structuredClone(input.constraints),authorization,allocation:null});
    } else {
      g=this.group(command.groupBuyId);
      if(g.version!==command.metadata.expectedVersion)throw new DomainError('VERSION_CONFLICT',true,g.version);
    }
    const previous=g.version; g.version++; const events: Event[]=[];
    switch (command.operation) {
      case 'create': await this.reprice(g,events); this.event(g,events,'group.created'); break;
      case 'join': {
        requireRule(g.status==='OPEN' && instant(g.joiningDeadline)>instant(this.clock.now()),'GROUP_NOT_OPEN');
        requireRule(!g.participants.some(p=>p.userId===actor.userId),'CONSTRAINTS_NOT_MET');
        await this.basket(command.input,g.merchantId);
        requireRule(fits(g.collection,command.input.constraints) && command.input.constraints.maxTotal.currency===g.participants[0]!.constraints.maxTotal.currency,'CONSTRAINTS_NOT_MET');
        const authorization=await this.grant(actor,command.input,g,'JOIN');
        g.participants.push({userId:actor.userId,lines:structuredClone(command.input.lines),constraints:structuredClone(command.input.constraints),authorization,allocation:null});
        g.arrangementFixed=true; await this.reprice(g,events); this.event(g,events,'participant.joined'); break;
      }
      case 'leave': {
        requireRule(mutable(g),'MEMBERSHIP_LOCKED');
        requireRule(g.participants.some(p=>p.userId===actor.userId),'FORBIDDEN');
        g.participants=g.participants.filter(p=>p.userId!==actor.userId); this.event(g,events,'participant.left',[actor.userId,...g.participants.map(p=>p.userId)]); await this.reprice(g,events); break;
      }
      case 'close': requireRule(actor.userId===g.organizerId,'FORBIDDEN'); requireRule(g.status==='OPEN','GROUP_NOT_OPEN'); g.status='FINALIZING'; this.event(g,events,'group.closed'); break;
      case 'cancel': requireRule(actor.userId===g.organizerId,'FORBIDDEN'); requireRule(mutable(g),'MEMBERSHIP_LOCKED'); g.status='CANCELLED'; for (const a of g.approvals) if(a.state==='PENDING')a.state='OBSOLETE'; this.event(g,events,'group.cancelled'); break;
      case 'respond': {
        requireRule(mutable(g),'MEMBERSHIP_LOCKED');
        requireRule(command.decision==='ACCEPT' || command.decision==='REJECT');
        const approval=g.approvals.find(a=>a.id===command.approvalRequestId); requireRule(approval,'APPROVAL_STALE'); requireRule(approval.participantId===actor.userId,'FORBIDDEN');
        requireRule(approval.state==='PENDING' && approval.orderRevision===g.orderRevision && g.quote && instant(g.quote.expiresAt)>instant(this.clock.now()),'APPROVAL_STALE');
        const participant=g.participants.find(p=>p.userId===actor.userId)!;
        requireRule(participant.allocation && canonical(participant.allocation.totalDebit)===canonical(approval.total),'APPROVAL_STALE');
        approval.state=command.decision==='ACCEPT'?'ACCEPTED':'REJECTED'; this.event(g,events,'approval.resolved',[actor.userId]);
        if(command.decision==='ACCEPT') participant.allocation.authorizationId=approval.id;
        else { g.participants=g.participants.filter(p=>p.userId!==actor.userId); this.event(g,events,'participant.left',[actor.userId,...g.participants.map(p=>p.userId)]); await this.reprice(g,events); }
        break;
      }
    }
    const result={group:this.view(g,actor),eventIds:events.map(e=>e.eventId)};
    return this.store.commit(g,previous,events,{key,fingerprint:hash,result})!;
    } catch(error) {
      const raced=this.store.command(key,hash);if(raced)return raced;
      throw error;
    }
  }
  // Payment adapter service lookup. Never expose this operation as a user tool.
  getPaymentAuthorization(submissionId: string, authorizationId: string): { userId: string; total: NonNullable<Group['quote']>['merchantTotal']; snapshot: PaymentSnapshot } | null {
    const g=this.store.groups().find(g=>g.payment?.submissionId===submissionId);
    const charge=g?.payment?.snapshot.participantCharges.find(c=>c.authorizationId===authorizationId);
    return g?.payment && charge ? structuredClone({userId:charge.participantId,total:charge.totalDebit,snapshot:g.payment.snapshot}) : null;
  }
  private lock(g: Group, events: Event[]): void {
    requireRule(g.quote && !g.blocker && instant(g.quote.expiresAt)>instant(this.clock.now()),'QUOTE_EXPIRED');
    for(const p of g.participants) {
      requireRule(p.allocation && fits(g.collection,p.constraints),'CONSTRAINTS_NOT_MET');
      if(amount(p.allocation.totalDebit)>amount(p.authorization.constraints.maxTotal,p.allocation.totalDebit.currency)) {
        requireRule(g.approvals.some(a=>a.id===p.allocation!.authorizationId && a.state==='ACCEPTED' && a.orderRevision===g.orderRevision && canonical(a.total)===canonical(p.allocation!.totalDebit)),'APPROVAL_STALE');
      }
    }
    const snapshot: PaymentSnapshot={...this.order(g),schemaVersion:'1',organizerId:g.organizerId,quoteId:g.quote.quoteId,quoteExpiresAt:g.quote.expiresAt,merchantTotal:g.quote.merchantTotal,participantCharges:g.participants.map(p=>p.allocation!)};
    g.payment={submissionId:`${g.id}:${g.orderRevision}`,snapshot:structuredClone(snapshot),status:null,dispatched:false}; g.status='COLLECTING'; this.event(g,events,'payment.intent_recorded');
  }
  private applyStatus(g: Group, status: PaymentStatus, events: Event[]): void {
    requireRule(g.payment && status.submissionId===g.payment.submissionId && status.orderRevision===g.payment.snapshot.orderRevision);
    requireRule(Number.isSafeInteger(status.sequence) && status.sequence>0 && typeof status.paymentOperationId==='string' && status.paymentOperationId.length>0);
    const previous=g.payment.status;
    requireRule(!previous || previous.paymentOperationId===status.paymentOperationId);
    if(previous && status.sequence<=previous.sequence) return;
    // Authoritative service snapshots are used, never raw callback payloads.
    if(previous?.state==='SUCCEEDED' || (previous?.state==='FAILED' && !previous.unresolvedFunds)) return;
    requireRule(['ACCEPTED','COLLECTING','ACTION_REQUIRED','PAYING','SUCCEEDED','RECOVERING','FAILED'].includes(status.state));
    requireRule(typeof status.unresolvedFunds==='boolean' && Array.isArray(status.nextActions));
    requireRule(status.nextActions.every(a=>(g.participants.some(p=>p.userId===a.targetUserId) || a.targetUserId===g.organizerId) && ['FUNDING_SETUP','CONTRIBUTION_APPROVAL','MERCHANT_APPROVAL','RECOVERY_REVIEW'].includes(a.kind) && typeof a.actionId==='string' && a.actionId.length>0 && typeof a.secureActionRef==='string' && a.secureActionRef.length>0 && (a.kind!=='MERCHANT_APPROVAL' || a.targetUserId===g.organizerId)));
    requireRule(Array.isArray(status.participantOutcomes) && status.participantOutcomes.length===g.participants.length && ['NOT_STARTED','PENDING','SUCCEEDED','FAILED','UNKNOWN'].includes(status.merchantStatus));
    requireRule(g.participants.every(p=>status.participantOutcomes.filter(o=>o.participantId===p.userId && ['PENDING','SUCCEEDED','FAILED','UNKNOWN'].includes(o.collection) && ['NONE','PENDING','SUCCEEDED','FAILED','UNKNOWN'].includes(o.refund)).length===1));
    requireRule(status.state!=='SUCCEEDED' || (!status.unresolvedFunds && status.merchantStatus==='SUCCEEDED' && status.participantOutcomes.every(p=>p.collection==='SUCCEEDED' && p.refund==='NONE')));
    requireRule(status.state!=='FAILED' || status.unresolvedFunds || (status.merchantStatus!=='UNKNOWN' && status.participantOutcomes.every(p=>p.collection==='FAILED' || (p.collection==='SUCCEEDED' && p.refund==='SUCCEEDED') || (p.collection==='PENDING' && p.refund==='NONE'))));
    g.blocker=null;
    g.payment.status={paymentOperationId:status.paymentOperationId,submissionId:status.submissionId,orderRevision:status.orderRevision,sequence:status.sequence,state:status.state,unresolvedFunds:status.unresolvedFunds,merchantStatus:status.merchantStatus,
      participantOutcomes:status.participantOutcomes.map(p=>({participantId:p.participantId,collection:p.collection,refund:p.refund})),
      nextActions:status.nextActions.map(a=>({actionId:a.actionId,kind:a.kind,targetUserId:a.targetUserId,secureActionRef:a.secureActionRef}))};
    g.status=status.state==='SUCCEEDED'?'COMPLETED':status.state==='FAILED'?(status.unresolvedFunds?'RECOVERING':'FAILED'):status.state==='RECOVERING'?'RECOVERING':status.state==='ACTION_REQUIRED'?'PAYMENT_ACTION_REQUIRED':status.state==='PAYING'?'PAYING':'COLLECTING';
    this.event(g,events,g.status==='COMPLETED'?'group.completed':g.status==='FAILED'?'group.failed':g.status==='PAYMENT_ACTION_REQUIRED'?'payment.action_required':'payment.status_changed');
  }
  // Called by an authenticated payment adapter. Always reconcile from the port on callbacks,
  // including duplicate/out-of-order/gapped events; untrusted payload cannot change state.
  async reconcile(submissionId: string): Promise<void> {
    const status=await this.payments.getGroupPayment(submissionId); if(!status)return;
    const found=this.store.groups().find(g=>g.payment?.submissionId===submissionId); if(!found)return;
    const g=found; const previous=g.version; g.version++; const events: Event[]=[];
    this.applyStatus(g,status,events); if(events.length)this.store.commit(g,previous,events);
  }
  // One bounded worker pass. Run on a server-owned timer, not a client session.
  async tick(): Promise<void> {
    for(const original of this.store.groups()) {
      try { await this.advance(original.id); } catch(error) { if(!(error instanceof DomainError) || error.code!=='VERSION_CONFLICT') throw error; }
    }
  }
  private async advance(id: string): Promise<void> {
    let g=this.group(id); let previous=g.version; const events: Event[]=[]; g.version++;
    if(mutable(g)) {
      if(instant(g.collection.window.endsAt)<=instant(this.clock.now())) { g.status='CANCELLED'; for(const approval of g.approvals)if(approval.state==='PENDING')approval.state='OBSOLETE'; this.event(g,events,'group.cancelled'); }
      else {
        if(g.status==='OPEN' && instant(g.joiningDeadline)<=instant(this.clock.now())) {g.status='FINALIZING';this.event(g,events,'group.closed');}
        if(!g.quote || instant(g.quote.expiresAt)<=instant(this.clock.now())) await this.reprice(g,events);
        if(g.status==='FINALIZING' && g.quote && !g.blocker && !g.approvals.some(a=>a.state==='PENDING' && a.orderRevision===g.orderRevision)) this.lock(g,events);
      }
      if(events.length)this.store.commit(g,previous,events);
    }
    g=this.group(id);
    if(!g.payment || ['COMPLETED','FAILED','CANCELLED'].includes(g.status))return;
    const submissionId=g.payment.submissionId;
    try {
      let status=await this.payments.getGroupPayment(g.payment.submissionId);
      if(!status) {
        if(instant(g.payment.snapshot.quoteExpiresAt)<=instant(this.clock.now())) {
          if(!g.payment.dispatched) {
            previous=g.version;g.version++;g.payment=null;g.status='FINALIZING';g.quote=null; const refreshed: Event[]=[]; await this.reprice(g,refreshed); this.store.commit(g,previous,refreshed); return;
          }
          status=await this.payments.requestRecovery(g.payment.submissionId,'QUOTE_EXPIRED_WITH_UNKNOWN_SUBMISSION');
        } else {
          if(!g.payment.dispatched) {previous=g.version;g.version++;g.payment.dispatched=true;this.store.commit(g,previous,[]);}
          status=await this.payments.startGroupPayment(structuredClone(g.payment.snapshot),g.payment.submissionId);
        }
      }
      g=this.group(id);previous=g.version;g.version++;const applied: Event[]=[];this.applyStatus(g,status,applied);if(applied.length)this.store.commit(g,previous,applied);
      if(g.status==='RECOVERING' && status.state==='FAILED' && status.unresolvedFunds) {
        await this.payments.requestRecovery(g.payment!.submissionId,'UNRESOLVED_FUNDS');
        await this.reconcile(g.payment!.submissionId);
      }
    } catch(error) {
      if(error instanceof DomainError && error.code==='VERSION_CONFLICT')return;
      // Lost response is financial uncertainty. Preserve immutable intent and lock.
      g=this.group(id); if(!g.payment || g.payment.submissionId!==submissionId || ['COMPLETED','FAILED','CANCELLED'].includes(g.status))return;
      previous=g.version;g.version++;g.status='RECOVERING';g.blocker='PROVIDER_UNAVAILABLE';const unknown: Event[]=[];this.event(g,unknown,'payment.unknown');this.store.commit(g,previous,unknown);
    }
  }
}
