// LOCAL_MOCK adapters only. These never connect to a provider or move funds.
import { DatabaseSync } from 'node:sqlite';
import type { ActorContext, Authorization, AuthorizationPort, CatalogPort, Clock, GroupPaymentPort, PaymentSnapshot, PaymentStatus, Quote, QuoteOrder, Variant } from './contract.js';
import { DomainError } from './contract.js';
import { amount, canonical, money, requireRule } from './rules.js';
export class FakeClock implements Clock {
  constructor(public time = '2030-01-01T00:00:00Z') {}
  now(): string { return this.time; }
}
export class DemoAuthorization implements AuthorizationPort {
  private readonly records = new Map<string, Authorization>();
  // Represents a trusted confirmation flow, deliberately not a user tool.
  record(grant: Authorization): string { this.records.set(grant.authorizationId,structuredClone(grant)); return grant.authorizationId; }
  async resolve(reference: string, actor: ActorContext): Promise<Authorization | null> {
    const grant=this.records.get(reference);return grant?.userId===actor.userId?structuredClone(grant):null;
  }
}
export class FakeCatalog implements CatalogPort {
  readonly variants: Variant[] = ['tea','cake','other'].map((id,index)=>({merchantId:id==='other'?'other-merchant':'merchant',productId:`product-${id}`,variantId:id,title:`LOCAL_MOCK ${id}`,attributes:{size:'exact'},indicativePrice:{currency:'USD',minor:index===1?'700':'900'},available:true}));
  async get(id: string): Promise<Variant | null> { return structuredClone(this.variants.find(v=>v.variantId===id) ?? null); }
  async search(query: string, merchantId?: string) { return {items:structuredClone(this.variants.filter(v=>(!merchantId || merchantId===v.merchantId) && v.title.includes(query))),nextCursor:null}; }
}
export class FakePayment implements GroupPaymentPort {
  private readonly db: DatabaseSync;
  delivery='600'; unitPrice='900'; fee='0'; quoteLifetime=3600000;
  evidence: Quote['evidence']='VERIFIED_LINES'; available=true; timeoutAfterAccept=false;
  quoteTransform: ((quote: Quote)=>Quote) | null=null;
  constructor(path: string, private readonly clock: Clock) {
    this.db=new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS mock_payments(submission_id TEXT PRIMARY KEY,snapshot TEXT NOT NULL,status TEXT NOT NULL);');
  }
  async quoteGroupOrder(order: QuoteOrder): Promise<Quote> {
    const lines=order.lines.map(l=>({...l,available:this.available,amount:money(order.currency,BigInt(this.unitPrice)*BigInt(l.quantity))}));
    const quote: Quote={quoteId:`local-mock:${order.groupBuyId}:${order.orderRevision}:${this.clock.now()}`,expiresAt:new Date(Date.parse(this.clock.now())+this.quoteLifetime).toISOString(),currency:order.currency,evidence:this.evidence,lines,sharedDelivery:money(order.currency,BigInt(this.delivery)),merchantTotal:money(order.currency,lines.reduce((a,l)=>a+amount(l.amount),BigInt(this.delivery))),fundingFees:[...new Set(order.lines.map(l=>l.participantId))].map(participantId=>({participantId,amount:money(order.currency,BigInt(this.fee))}))};
    return this.quoteTransform?this.quoteTransform(quote):quote;
  }
  async startGroupPayment(snapshot: PaymentSnapshot, submissionId: string): Promise<PaymentStatus> {
    // The mock has the same durable deduplication seam required of the payment teammate.
    this.db.exec('BEGIN IMMEDIATE');
    let result: PaymentStatus;
    try {
      const row=this.db.prepare('SELECT snapshot,status FROM mock_payments WHERE submission_id=?').get(submissionId);
      if(row) {requireRule(row.snapshot===canonical(snapshot),'IDEMPOTENCY_CONFLICT');result=JSON.parse(String(row.status)) as PaymentStatus;}
      else {
        requireRule(Date.parse(snapshot.quoteExpiresAt)>Date.parse(this.clock.now()),'QUOTE_EXPIRED');
        result={paymentOperationId:`local-mock:${submissionId}`,submissionId,orderRevision:snapshot.orderRevision,sequence:1,state:'COLLECTING',unresolvedFunds:false,merchantStatus:'NOT_STARTED',participantOutcomes:snapshot.participantCharges.map(c=>({participantId:c.participantId,collection:'PENDING',refund:'NONE'})),nextActions:[]};
        this.db.prepare('INSERT INTO mock_payments VALUES(?,?,?)').run(submissionId,canonical(snapshot),JSON.stringify(result));
      }
      this.db.exec('COMMIT');
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
    if(this.timeoutAfterAccept) {this.timeoutAfterAccept=false;throw new DomainError('PROVIDER_UNAVAILABLE',true);}
    return result;
  }
  async getGroupPayment(submissionId: string): Promise<PaymentStatus | null> {
    const row=this.db.prepare('SELECT status FROM mock_payments WHERE submission_id=?').get(submissionId);
    return row?JSON.parse(String(row.status)) as PaymentStatus:null;
  }
  async requestRecovery(submissionId: string, _reason: string): Promise<PaymentStatus> {
    const status=await this.getGroupPayment(submissionId); requireRule(status,'NOT_FOUND');
    return this.setStatus(submissionId,{state:'RECOVERING',unresolvedFunds:true});
  }
  setStatus(submissionId: string, patch: Partial<Pick<PaymentStatus,'state'|'unresolvedFunds'|'nextActions'|'sequence'|'merchantStatus'|'participantOutcomes'>>): PaymentStatus {
    const row=this.db.prepare('SELECT status FROM mock_payments WHERE submission_id=?').get(submissionId);requireRule(row,'NOT_FOUND');
    const previous=JSON.parse(String(row.status)) as PaymentStatus;
    const status: PaymentStatus={...previous,sequence:previous.sequence+1,...patch};
    if(patch.state==='SUCCEEDED' && !patch.participantOutcomes) {status.merchantStatus='SUCCEEDED';status.participantOutcomes=previous.participantOutcomes.map(p=>({...p,collection:'SUCCEEDED',refund:'NONE'}));}
    if(patch.state==='FAILED' && patch.unresolvedFunds===false && !patch.participantOutcomes) {status.merchantStatus='FAILED';status.participantOutcomes=previous.participantOutcomes.map(p=>({...p,collection:'FAILED',refund:'NONE'}));}
    this.db.prepare('UPDATE mock_payments SET status=? WHERE submission_id=?').run(JSON.stringify(status),submissionId);
    return status;
  }
  count(): number { return Number(this.db.prepare('SELECT COUNT(*) count FROM mock_payments').get()!.count); }
  snapshots(): PaymentSnapshot[] { return this.db.prepare('SELECT snapshot FROM mock_payments').all().map(row=>JSON.parse(String(row.snapshot)) as PaymentSnapshot); }
  close(): void {this.db.close();}
}
