import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Mutation } from './contract.js';
import { Orchestration } from './application.js';
import { collection, demoWorld } from './demo-fixture.js';
import { amount } from './rules.js';
import { SqliteStore } from './sqlite-fixture-store.js';
import type { Store } from './store.js';
import { runWorker } from './worker.js';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgresStore } from './postgres-store.js';

// Expected outcomes are T1-T7 in docs/plans/orchestration-handoff/acceptance-checks.md.
const cleanup: (()=>void | Promise<void>)[]=[];
afterEach(async()=>{for(const dispose of cleanup.splice(0).reverse())await dispose();});
const postgresUrl=process.env.ORCHESTRATION_TEST_DATABASE_URL;
async function setup(adapter: 'sqlite' | 'postgres') {
  const dir=mkdtempSync(join(tmpdir(),'houjicha-tests-'));
  cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'core.sqlite');const w=demoWorld(path);cleanup.push(w.close);
  const schema=`test_${randomUUID().replaceAll('-','')}`;
  const restart=()=>adapter==='postgres'?new PostgresStore({connectionString:postgresUrl!},schema):new SqliteStore(path);
  const store=adapter==='postgres'?restart():w.store;
  if(adapter==='postgres') {
    const admin=new Pool({connectionString:postgresUrl!});
    try {await admin.query(readFileSync(new URL('../../supabase/schema.sql',import.meta.url),'utf8').replaceAll('orchestration',schema));}
    finally {await admin.end();}
    cleanup.push(async()=>{const admin=new Pool({connectionString:postgresUrl!});try{await admin.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await admin.end();}});
    cleanup.push(()=>store.close());
  }
  return {...w,store,app:new Orchestration(store,w.catalog,w.payment,w.grants,w.clock),path,restart};
}
const alice={userId:'alice'},bob={userId:'bob'},cara={userId:'cara'};
async function create(w: Awaited<ReturnType<typeof setup>>, max='1150', offered=collection, key='create') {
  return (await w.app.execute(alice,{operation:'create',metadata:{commandId:key,expectedVersion:0},input:w.input('alice','HOST',max,offered)})).group.id;
}
async function execute(w: Awaited<ReturnType<typeof setup>>,userId: string,id: string,operation:'leave'|'close'|'cancel',key=operation) {
  return w.app.execute({userId},{operation,groupBuyId:id,metadata:{commandId:key,expectedVersion:(await w.app.getGroupBuy({userId},id)).version}});
}
async function add(w: Awaited<ReturnType<typeof setup>>, id: string,userId: string,max='1150',variantId='tea') {
  return w.app.execute({userId},{operation:'join',groupBuyId:id,input:w.basket(userId,max,collection,variantId),metadata:{commandId:`join-${userId}`,expectedVersion:(await w.app.getGroupBuy({userId},id)).version}});
}
async function respond(w: Awaited<ReturnType<typeof setup>>, id: string,userId: string,decision:'ACCEPT'|'REJECT',request?:string) {
  const view=(await w.app.getGroupBuy({userId},id));const approvalRequestId=request ?? view.approvals.find(a=>a.state==='PENDING')!.id;
  return w.app.execute({userId},{operation:'respond',groupBuyId:id,approvalRequestId,decision,metadata:{commandId:`response-${approvalRequestId}-${view.version}`,expectedVersion:view.version}});
}
async function trio(w: Awaited<ReturnType<typeof setup>>,max='1150') {const id=await create(w,max);await add(w,id,'bob',max);await add(w,id,'cara',max);return id;}

for(const adapter of ['sqlite','postgres'] as const) {
describe.skipIf(adapter==='postgres' && !postgresUrl)(`handoff acceptance: LOCAL_MOCK payment with ${adapter}`,()=>{
  it('T1: three-person approval cascade, stale approval, immutable one-payment lock and confirmation',async()=>{
    const w=await setup(adapter);const id=await trio(w);
    for(const actor of [alice,bob,cara])expect((await w.app.getGroupBuy(actor,id)).ownParticipant!.allocation!.totalDebit.minor).toBe('1100');
    await execute(w,'bob',id,'leave');
    const stale=(await w.app.getGroupBuy(alice,id)).approvals.find(a=>a.state==='PENDING')!.id;
    for(const actor of [alice,cara])expect((await w.app.getGroupBuy(actor,id)).ownParticipant!.allocation!.totalDebit.minor).toBe('1200');
    await execute(w,'alice',id,'close');await w.app.tick();expect(w.payment.count()).toBe(0);
    const revision=(await w.app.getGroupBuy(alice,id)).orderRevision;
    await respond(w,id,'alice','ACCEPT');expect((await w.app.getGroupBuy(alice,id)).orderRevision).toBe(revision);
    await respond(w,id,'cara','REJECT');expect((await w.app.getGroupBuy(alice,id)).ownParticipant!.allocation!.totalDebit.minor).toBe('1500');
    await expect(respond(w,id,'alice','ACCEPT',stale)).rejects.toMatchObject({code:'APPROVAL_STALE'});
    await w.app.tick();expect(w.payment.count()).toBe(0);
    await respond(w,id,'alice','ACCEPT');await w.app.tick();await w.app.tick();expect(w.payment.count()).toBe(1);
    const view=(await w.app.getGroupBuy(alice,id));expect(view.status).toBe('COLLECTING');expect(w.payment.snapshots()[0]!.participantCharges[0]!.totalDebit.minor).toBe('1500');
    expect((await w.app.getPaymentAuthorization(view.payment!.submissionId,view.ownParticipant!.allocation!.authorizationId))?.total.minor).toBe('1500');
    await expect(execute(w,'alice',id,'leave')).rejects.toMatchObject({code:'MEMBERSHIP_LOCKED'});
    w.payment.setStatus(view.payment!.submissionId,{state:'SUCCEEDED',unresolvedFunds:false});await w.app.tick();expect((await w.app.getGroupBuy(alice,id)).status).toBe('COMPLETED');
  });
  it('T1: rejection before first acceptance makes the 1200 response stale',async()=>{
    const w=await setup(adapter);const id=await trio(w);await execute(w,'bob',id,'leave');const stale=(await w.app.getGroupBuy(alice,id)).approvals.find(a=>a.state==='PENDING')!.id;
    await respond(w,id,'cara','REJECT');await expect(respond(w,id,'alice','ACCEPT',stale)).rejects.toMatchObject({code:'APPROVAL_STALE'});
  });
  it('T2: filters before ranking and permits new exact variants, freezes arrangements permanently',async()=>{
    const w=await setup(adapter);const far=await create(w,'5000',{...collection,point:{...collection.point,latitude:1.32}},'far');
    const near=await create(w,'5000',{...collection,point:{...collection.point,latitude:1.31}},'near');
    await create(w,'5000',{...collection,window:{...collection.window,endsAt:'2030-01-04T12:00:00Z'}},'ineligible');
    const input=w.basket('bob','5000');const found=await w.app.findGroupBuys(bob,'merchant',input);
    expect(found.map(r=>r.group.id)).toEqual([near,far]);expect(found[0]!.pricing).toBe('INDICATIVE');
    await expect(w.app.execute(bob,{operation:'join',groupBuyId:near,input:{...w.basket('bob','5000'),authorizationRef:'agent says consent'},metadata:{commandId:'untrusted',expectedVersion:(await w.app.getGroupBuy(bob,near)).version}})).rejects.toMatchObject({code:'FORBIDDEN'});
    const main=await create(w,'5000',collection,'main');await add(w,main,'bob','5000','cake');await execute(w,'bob',main,'leave');expect((await w.app.getGroupBuy(alice,main)).arrangementFixed).toBe(true);
    await expect(add(w,main,'cara','5000','other')).rejects.toMatchObject({code:'CONSTRAINTS_NOT_MET'});
    w.catalog.variants.find(v=>v.variantId==='cake')!.available=false;await expect(add(w,main,'cara','5000','cake')).rejects.toMatchObject({code:'ITEM_UNAVAILABLE'});
    const limited=w.basket('cara','5000');limited.constraints.maxDistanceMeters=0;limited.constraints.origin.latitude=2;
    await expect(w.app.execute(cara,{operation:'join',groupBuyId:main,input:limited,metadata:{commandId:'distance',expectedVersion:(await w.app.getGroupBuy(cara,main)).version}})).rejects.toMatchObject({code:'CONSTRAINTS_NOT_MET'});
  });
  it('T3: concurrent duplicate creates/joins replay after restart, changed payload conflicts',async()=>{
    const w=await setup(adapter);const command: Mutation={operation:'create',metadata:{commandId:'same-create',expectedVersion:0},input:w.input('alice','HOST','5000')};
    const [a,b]=await Promise.all([w.app.execute(alice,command),w.app.execute(alice,command)]);expect(a).toEqual(b);expect((await w.store.groups())).toHaveLength(1);
    const id=a.group.id;const joinCommand: Mutation={operation:'join',groupBuyId:id,input:w.basket('bob','5000'),metadata:{commandId:'same-join',expectedVersion:a.group.version}};
    const results=await Promise.all([w.app.execute(bob,joinCommand),w.app.execute(bob,joinCommand)]);expect(results[0]).toEqual(results[1]);expect((await w.store.read(id))!.participants).toHaveLength(2);
    const restartedStore=w.restart();cleanup.push(()=>restartedStore.close());const restarted=new Orchestration(restartedStore,w.catalog,w.payment,w.grants,w.clock);
    expect(await restarted.execute(bob,joinCommand)).toEqual(results[0]);
    await expect(restarted.execute(bob,{...joinCommand,metadata:{...joinCommand.metadata,expectedVersion:999}})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  });
  it('T3: join/close and leave/lock races serialize, competing workers share one payment operation',async()=>{
    const w=await setup(adapter);const id=await create(w,'5000');const version=(await w.app.getGroupBuy(alice,id)).version;
    const results=await Promise.allSettled([w.app.execute(bob,{operation:'join',groupBuyId:id,input:w.basket('bob','5000'),metadata:{commandId:'race-join',expectedVersion:version}}),w.app.execute(alice,{operation:'close',groupBuyId:id,metadata:{commandId:'race-close',expectedVersion:version}})]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    if((await w.app.getGroupBuy(alice,id)).status==='OPEN')await execute(w,'alice',id,'close');
    const otherStore=w.restart();cleanup.push(()=>otherStore.close());const other=new Orchestration(otherStore,w.catalog,w.payment,w.grants,w.clock);
    const race=await Promise.allSettled([w.app.tick(),other.tick(),execute(w,'alice',id,'leave')]);
    // T3 permits either serialized winner. Async I/O must not pick a winner by call order.
    await w.app.tick();
    const remaining=(await w.store.read(id))!.participants;
    if(!remaining.length) {expect((await w.app.getGroupBuy(alice,id)).status).toBe('CANCELLED');expect(w.payment.count()).toBe(0);}
    else {
      expect(w.payment.count()).toBe(1);
      expect(w.payment.snapshots()[0]!.lines.map(l=>l.participantId).sort()).toEqual(remaining.map(p=>p.userId).sort());
    }
    if(race[2]!.status==='fulfilled')expect(remaining.some(p=>p.userId==='alice')).toBe(false);
    else expect(['MEMBERSHIP_LOCKED','VERSION_CONFLICT']).toContain((race[2]!.reason as {code:string}).code);
  });
  it('T4: stable 601 remainder split, exact sums and no mandatory click within grants',async()=>{
    const w=await setup(adapter);w.payment.delivery='601';const id=await trio(w,'5000');
    expect(await Promise.all([alice,bob,cara].map(async a=>(await w.app.getGroupBuy(a,id)).ownParticipant!.allocation!.merchantShare.minor))).toEqual(['1101','1100','1100']);
    const g=(await w.store.read(id))!;expect(g.participants.reduce((a,p)=>a+amount(p.allocation!.merchantShare),0n)).toBe(3301n);
    await execute(w,'alice',id,'close');await w.app.tick();expect(w.payment.count()).toBe(1);expect(g.approvals).toHaveLength(0);
  });
  it.each(['mixed','malformed','precision','total','unavailable','aggregate'] as const)('T4: blocks %s quote without dispatch',async kind=>{
    const w=await setup(adapter);w.payment.quoteTransform=q=>{
      if(kind==='mixed')q.lines[0]!.amount.currency='EUR';
      if(kind==='malformed')q.lines[0]!.amount.minor='1e3';
      if(kind==='precision')q.lines[0]!.amount.minor='1.5';
      if(kind==='total')q.merchantTotal.minor='999';
      if(kind==='unavailable')q.lines[0]!.available=false;
      if(kind==='aggregate')q.evidence='AGGREGATE_ONLY';return q;
    };
    const id=await create(w,'5000');await execute(w,'alice',id,'close');await w.app.tick();expect(w.payment.count()).toBe(0);expect((await w.app.getGroupBuy(alice,id)).blocker).not.toBeNull();
  });
  it('T4: expired quote refresh supersedes pending approvals and never dispatches expired terms',async()=>{
    const w=await setup(adapter);const id=await trio(w);await execute(w,'bob',id,'leave');const old=(await w.app.getGroupBuy(alice,id)).approvals.find(a=>a.state==='PENDING')!.id;
    w.clock.time='2030-01-01T02:00:00Z';await w.app.tick();expect((await w.app.getGroupBuy(alice,id)).status).toBe('FINALIZING');
    await expect(respond(w,id,'alice','ACCEPT',old)).rejects.toMatchObject({code:'APPROVAL_STALE'});expect(w.payment.count()).toBe(0);
    expect((await w.app.getGroupBuy(alice,id)).approvals.find(a=>a.state==='PENDING')!.id).not.toBe(old);
  });
  it('T5: partial collection and failed refunds stay locked until confirmed clean failure',async()=>{
    const w=await setup(adapter);const id=await trio(w,'5000');await execute(w,'alice',id,'close');await w.app.tick();const submission=(await w.app.getGroupBuy(alice,id)).payment!.submissionId;
    w.payment.setStatus(submission,{state:'FAILED',unresolvedFunds:true,participantOutcomes:[{participantId:'alice',collection:'SUCCEEDED',refund:'PENDING'},{participantId:'bob',collection:'SUCCEEDED',refund:'PENDING'},{participantId:'cara',collection:'FAILED',refund:'NONE'}]});await w.app.tick();expect((await w.app.getGroupBuy(alice,id)).status).toBe('RECOVERING');expect(w.payment.count()).toBe(1);
    await expect(execute(w,'bob',id,'leave')).rejects.toMatchObject({code:'MEMBERSHIP_LOCKED'});
    w.payment.setStatus(submission,{state:'RECOVERING',unresolvedFunds:true,participantOutcomes:[{participantId:'alice',collection:'SUCCEEDED',refund:'FAILED'},{participantId:'bob',collection:'SUCCEEDED',refund:'PENDING'},{participantId:'cara',collection:'FAILED',refund:'NONE'}]});await w.app.tick();expect((await w.app.getGroupBuy(alice,id)).status).toBe('RECOVERING');
    w.payment.setStatus(submission,{state:'FAILED',unresolvedFunds:false,merchantStatus:'FAILED',participantOutcomes:[{participantId:'alice',collection:'SUCCEEDED',refund:'SUCCEEDED'},{participantId:'bob',collection:'SUCCEEDED',refund:'SUCCEEDED'},{participantId:'cara',collection:'FAILED',refund:'NONE'}]});await w.app.tick();expect((await w.app.getGroupBuy(alice,id)).status).toBe('FAILED');await w.app.tick();expect(w.payment.count()).toBe(1);
  });
  it('T5/T7: response lost after dispatch, restart, late success and out-of-order status never resubmit/regress',async()=>{
    const w=await setup(adapter);const id=await trio(w,'5000');await execute(w,'alice',id,'close');w.payment.timeoutAfterAccept=true;await w.app.tick();expect((await w.app.getGroupBuy(alice,id)).status).toBe('RECOVERING');
    const restartedStore=w.restart();cleanup.push(()=>restartedStore.close());const restarted=new Orchestration(restartedStore,w.catalog,w.payment,w.grants,w.clock);
    const submission=(await w.app.getGroupBuy(alice,id)).payment!.submissionId;w.payment.setStatus(submission,{state:'SUCCEEDED',unresolvedFunds:false});await restarted.tick();expect((await restarted.getGroupBuy(alice,id)).status).toBe('COMPLETED');
    w.payment.setStatus(submission,{state:'COLLECTING',sequence:1});await restarted.reconcile(submission);expect((await restarted.getGroupBuy(alice,id)).status).toBe('COMPLETED');expect(w.payment.count()).toBe(1);
  });
  it('T6: actors cannot approve/close for others, spoof identity or read private actions',async()=>{
    const w=await setup(adapter);const id=await trio(w);await execute(w,'bob',id,'leave');const approval=(await w.app.getGroupBuy(alice,id)).approvals.find(a=>a.state==='PENDING')!;
    await expect(w.app.execute(cara,{operation:'respond',groupBuyId:id,approvalRequestId:approval.id,decision:'ACCEPT',metadata:{commandId:'spoof',expectedVersion:(await w.app.getGroupBuy(cara,id)).version}})).rejects.toMatchObject({code:'FORBIDDEN'});
    await expect(execute(w,'cara',id,'close')).rejects.toMatchObject({code:'FORBIDDEN'});
    const spoof={operation:'close',groupBuyId:id,userId:'alice',metadata:{commandId:'spoof-close',expectedVersion:(await w.app.getGroupBuy(cara,id)).version}} as unknown as Mutation;
    await expect(w.app.execute(cara,spoof)).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    await respond(w,id,'alice','ACCEPT');await respond(w,id,'cara','ACCEPT');await execute(w,'alice',id,'close');await w.app.tick();const submission=(await w.app.getGroupBuy(alice,id)).payment!.submissionId;
    w.payment.setStatus(submission,{state:'ACTION_REQUIRED',nextActions:[{actionId:'private',kind:'MERCHANT_APPROVAL',targetUserId:'alice',secureActionRef:'mock-private'}]});await w.app.tick();
    expect((await w.app.getPaymentStatus(cara,id))!.nextActions).toEqual([]);expect((await w.app.getPaymentStatus(alice,id))!.nextActions).toHaveLength(1);
    expect((await w.app.getGroupBuy(cara,id)).ownParticipant!.userId).toBe('cara');expect((await w.app.getGroupBuy({userId:'outsider'},id)).collection.point.address).toBe('');
    expect(JSON.stringify((await w.app.getMyUpdates(cara)))).not.toContain('mock-private');
  });
  // Regression schedules identified in the independent review. Authority comes from R5/C2,
  // command retries from S3, and recovery/obsolete approvals from T4/T7.
  it('S3: a failed event insert rolls back the aggregate, command and all earlier events',async()=>{
    const w=await setup(adapter);const id=await create(w,'5000');const original=(await w.store.read(id))!;
    const existing=(await w.app.getMyUpdates(alice)).items[0]!;
    const attempted=structuredClone(original);attempted.version++;
    const first={...existing,eventId:randomUUID(),sequence:original.eventSequence+1,recipients:['alice']};
    const duplicate={...existing,recipients:['alice']};
    const result={group:await w.app.getGroupBuy(alice,id),eventIds:[first.eventId,duplicate.eventId]};
    await expect(Promise.resolve().then(()=>w.store.commit(attempted,original.version,[first,duplicate],{key:'rollback',fingerprint:'rollback',result}))).rejects.toBeDefined();
    expect(await w.store.read(id)).toEqual(original);expect(await w.store.command('rollback','rollback')).toBeNull();
    expect((await w.app.getMyUpdates(alice)).items.some(event=>event.eventId===first.eventId)).toBe(false);
  });
  it('R5: one consent grant cannot authorize purchases in two separate groups',async()=>{
    const w=await setup(adapter);const input=w.input('alice','HOST','5000');
    const first=await w.app.execute(alice,{operation:'create',input,metadata:{commandId:'grant-once',expectedVersion:0}});
    await expect(w.app.execute(alice,{operation:'create',input,metadata:{commandId:'grant-again',expectedVersion:0}})).rejects.toMatchObject({code:'FORBIDDEN'});
    expect((await w.store.groups())).toHaveLength(1);await execute(w,'alice',first.group.id,'close');await w.app.tick();expect(w.payment.count()).toBe(1);
  });
  it('S3: original command result wins if another process commits between lookup and version read',async()=>{
    const w=await setup(adapter);const id=await create(w,'5000');
    const command: Mutation={operation:'join',groupBuyId:id,input:w.basket('bob','5000'),metadata:{commandId:'lookup-race',expectedVersion:(await w.app.getGroupBuy(bob,id)).version}};
    const original=await w.app.execute(bob,command);let firstLookup=true;
    const delayedLookup: Store={read:w.store.read.bind(w.store),groups:w.store.groups.bind(w.store),updates:w.store.updates.bind(w.store),commit:w.store.commit.bind(w.store),close:()=>{},command:(key,hash)=>{if(firstLookup){firstLookup=false;return null;}return w.store.command(key,hash);}};
    const retry=new Orchestration(delayedLookup,w.catalog,w.payment,w.grants,w.clock);
    expect(await retry.execute(bob,command)).toEqual(original);expect((await w.store.read(id))!.participants).toHaveLength(2);
  });
  it('T7: a stale worker failure cannot poison newly refreshed finalization without payment intent',async()=>{
    const w=await setup(adapter);const id=await create(w,'5000');await execute(w,'alice',id,'close');
    const firstFailure={quoteGroupOrder:w.payment.quoteGroupOrder.bind(w.payment),startGroupPayment:w.payment.startGroupPayment.bind(w.payment),requestRecovery:w.payment.requestRecovery.bind(w.payment),getGroupPayment:async()=>{throw new Error('before dispatch');}};
    await new Orchestration(w.store,w.catalog,firstFailure,w.grants,w.clock).tick();expect((await w.store.read(id))!.payment!.dispatched).toBe(false);w.clock.time='2030-01-01T02:00:00Z';
    let entered!:()=>void;const lookupEntered=new Promise<void>(resolve=>{entered=resolve;});let fail!: (error:Error)=>void;
    const paused={...firstFailure,getGroupPayment:async()=>{entered();return new Promise<null>((_resolve,reject)=>{fail=reject;});}};
    const stale=new Orchestration(w.store,w.catalog,paused,w.grants,w.clock).tick();await lookupEntered;
    await w.app.tick();expect((await w.store.read(id))!.payment).toBeNull();expect((await w.app.getGroupBuy(alice,id)).status).toBe('FINALIZING');fail(new Error('stale lookup failed'));await stale;
    expect((await w.app.getGroupBuy(alice,id)).status).toBe('FINALIZING');await w.app.tick();expect(w.payment.count()).toBe(1);
  });
  it('T7: automatic infeasibility cancellation removes pending approval actions',async()=>{
    const w=await setup(adapter);const id=await create(w);expect((await w.app.getMyUpdates(alice)).pending).toHaveLength(1);w.clock.time='2030-01-03T00:00:00Z';await w.app.tick();
    expect((await w.app.getGroupBuy(alice,id)).status).toBe('CANCELLED');expect((await w.app.getMyUpdates(alice)).pending).toEqual([]);expect((await w.app.getGroupBuy(alice,id)).approvals.every(a=>a.state==='OBSOLETE')).toBe(true);
  });
  it('T7: backend worker loop processes a durable deadline without any connected client',async()=>{
    const w=await setup(adapter);const id=await trio(w,'5000');w.clock.time='2030-01-01T00:31:00Z';
    const controller=new AbortController();
    const port={quoteGroupOrder:w.payment.quoteGroupOrder.bind(w.payment),getGroupPayment:w.payment.getGroupPayment.bind(w.payment),requestRecovery:w.payment.requestRecovery.bind(w.payment),startGroupPayment:async(...args:Parameters<typeof w.payment.startGroupPayment>)=>{const status=await w.payment.startGroupPayment(...args);controller.abort();return status;}};
    const backend=new Orchestration(w.store,w.catalog,port,w.grants,w.clock);const errors:unknown[]=[];
    await runWorker(backend,{signal:controller.signal,onError:error=>{errors.push(error);controller.abort();}});
    expect(errors).toEqual([]);expect((await w.app.getGroupBuy(alice,id)).status).toBe('COLLECTING');expect(w.payment.count()).toBe(1);
  });
  it('T7: no clients needed for deadline, restart before dispatch and scoped cursor replay',async()=>{
    const w=await setup(adapter);const id=await trio(w,'5000');const before=(await w.app.getMyUpdates(alice));w.clock.time='2030-01-01T00:31:00Z';
    const brokenPort={quoteGroupOrder:w.payment.quoteGroupOrder.bind(w.payment),startGroupPayment:w.payment.startGroupPayment.bind(w.payment),getGroupPayment:async()=>{throw new Error('crash before dispatch');},requestRecovery:w.payment.requestRecovery.bind(w.payment)};
    await new Orchestration(w.store,w.catalog,brokenPort,w.grants,w.clock).tick();expect(w.payment.count()).toBe(0);expect((await w.store.read(id))!.payment?.dispatched).toBe(false);
    const restart=w.restart();cleanup.push(()=>restart.close());await new Orchestration(restart,w.catalog,w.payment,w.grants,w.clock).tick();expect(w.payment.count()).toBe(1);
    const after=(await w.app.getMyUpdates(alice,before.nextCursor));expect(after.items.some(e=>e.type==='group.closed')).toBe(true);expect(after.nextCursor).toBeGreaterThan(before.nextCursor);
    const sequences=(await w.app.getMyUpdates(alice)).items.filter(e=>e.aggregateId===id).map(e=>e.sequence);expect(new Set(sequences).size).toBe(sequences.length);expect(sequences).toEqual([...sequences].sort((a,b)=>a-b));
    expect((await w.app.getMyUpdates({userId:'outsider'})).items).toEqual([]);
  });
});
}
