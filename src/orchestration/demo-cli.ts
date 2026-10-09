import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgresStore } from './postgres-store.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Orchestration } from './application.js';
import { demoWorld } from './demo-fixture.js';
import { DomainError } from './contract.js';
import type { GroupView, Mutation } from './contract.js';

// Each phase is a fresh OS process against the same SQLite database.
const phase=process.argv[2];const directory=process.argv[3];
if(!phase) {
  const dir=mkdtempSync(join(tmpdir(),'houjicha-demo-'));
  const schema=`demo_${randomUUID().replaceAll('-','')}`;
  const admin=process.env.ORCHESTRATION_TEST_DATABASE_URL?new Pool({connectionString:process.env.ORCHESTRATION_TEST_DATABASE_URL}):null;
  if(admin)await admin.query(readFileSync(new URL('../../supabase/schema.sql',import.meta.url),'utf8').replaceAll('orchestration',schema));
  try {
    console.log(`LOCAL_MOCK payment. ${admin?'PostgreSQL':'SQLite fixture'} core persistence. No provider calls or fund movement.`);
    for(const stage of ['cascade','intent','lost-response','late-success']) {
      const child=spawnSync(process.execPath,['--import','tsx',fileURLToPath(import.meta.url),stage,dir],{encoding:'utf8',env:{...process.env,ORCHESTRATION_DEMO_SCHEMA:schema}});
      process.stdout.write(child.stdout);process.stderr.write(child.stderr);assert.equal(child.status,0,`phase ${stage} failed`);
    }
    console.log('PASS: 3 actors, approval cascade, 4 process lifetimes, one immutable payment operation, late success, durable updates.');
  } finally {if(admin){try{await admin.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await admin.end();}}rmSync(dir,{recursive:true,force:true});}
} else {
  assert(directory);const path=join(directory,'core.sqlite');const stateFile=join(directory,'state.json');const pgStore=process.env.ORCHESTRATION_TEST_DATABASE_URL?new PostgresStore({connectionString:process.env.ORCHESTRATION_TEST_DATABASE_URL},process.env.ORCHESTRATION_DEMO_SCHEMA!):undefined;const w=demoWorld(path,pgStore);const alice={userId:'alice'};
  const log=(label:string,g:GroupView)=>console.log(JSON.stringify({label,version:g.version,orderRevision:g.orderRevision,status:g.status,participantCount:g.participantCount,ownTotal:g.ownParticipant?.allocation?.totalDebit,approvals:g.approvals.map(a=>({id:a.id,revision:a.orderRevision,total:a.total,state:a.state})),payment:g.payment}));
  try {
    if(phase==='cascade') {
      const created=await w.app.execute(alice,{operation:'create',metadata:{commandId:'host',expectedVersion:0},input:w.input('alice','HOST')});const id=created.group.id;
      for(const userId of ['bob','cara'])await w.app.execute({userId},{operation:'join',groupBuyId:id,metadata:{commandId:`join-${userId}`,expectedVersion:(await w.app.getGroupBuy(alice,id)).version},input:w.basket(userId)});
      for(const userId of ['alice','bob','cara'])assert.equal((await w.app.getGroupBuy({userId},id)).ownParticipant!.allocation!.totalDebit.minor,'1100');log('three shares 1100',(await w.app.getGroupBuy(alice,id)));
      await w.app.execute({userId:'bob'},{operation:'leave',groupBuyId:id,metadata:{commandId:'bob-leaves',expectedVersion:(await w.app.getGroupBuy(alice,id)).version}});
      await w.app.execute(alice,{operation:'close',groupBuyId:id,metadata:{commandId:'close',expectedVersion:(await w.app.getGroupBuy(alice,id)).version}});await w.app.tick();assert.equal(w.payment.count(),0);
      const approval=(await w.app.getGroupBuy(alice,id)).approvals.find(a=>a.state==='PENDING')!;assert.equal(approval.total.minor,'1200');
      await w.app.execute(alice,{operation:'respond',groupBuyId:id,approvalRequestId:approval.id,decision:'ACCEPT',metadata:{commandId:'alice-1200',expectedVersion:(await w.app.getGroupBuy(alice,id)).version}});
      const rejected=(await w.app.getGroupBuy({userId:'cara'},id)).approvals.find(a=>a.state==='PENDING')!;
      await w.app.execute({userId:'cara'},{operation:'respond',groupBuyId:id,approvalRequestId:rejected.id,decision:'REJECT',metadata:{commandId:'cara-rejects',expectedVersion:(await w.app.getGroupBuy(alice,id)).version}});
      const final=(await w.app.getGroupBuy(alice,id));assert.equal(final.ownParticipant!.allocation!.totalDebit.minor,'1500');assert(final.approvals.some(a=>a.state==='PENDING'));assert.equal(w.payment.count(),0);log('new 1500 authorization required',final);
      writeFileSync(stateFile,JSON.stringify({id,oldApproval:approval.id,cursor:(await w.app.getMyUpdates(alice)).nextCursor}));
    } else {
      const state=JSON.parse(readFileSync(stateFile,'utf8')) as {id:string;oldApproval:string;cursor:number;approvalCommand?:Mutation;approvalResult?:unknown};const id=state.id;
      if(phase==='intent') {
        await assert.rejects(w.app.execute(alice,{operation:'respond',groupBuyId:id,approvalRequestId:state.oldApproval,decision:'ACCEPT',metadata:{commandId:'stale-1200',expectedVersion:(await w.app.getGroupBuy(alice,id)).version}}),(error:unknown)=>error instanceof DomainError && error.code==='APPROVAL_STALE');
        const view=(await w.app.getGroupBuy(alice,id));state.approvalCommand={operation:'respond',groupBuyId:id,approvalRequestId:view.approvals.find(a=>a.state==='PENDING')!.id,decision:'ACCEPT',metadata:{commandId:'alice-1500',expectedVersion:view.version}};
        state.approvalResult=await w.app.execute(alice,state.approvalCommand);writeFileSync(stateFile,JSON.stringify(state));
        const unavailable={quoteGroupOrder:w.payment.quoteGroupOrder.bind(w.payment),getGroupPayment:async()=>{throw new Error('LOCAL_MOCK interruption before dispatch');},startGroupPayment:w.payment.startGroupPayment.bind(w.payment),requestRecovery:w.payment.requestRecovery.bind(w.payment)};
        await new Orchestration(w.store,w.catalog,unavailable,w.grants,w.clock).tick();assert.equal(w.payment.count(),0);assert((await w.store.read(id))!.payment);assert.equal((await w.store.read(id))!.payment!.dispatched,false);log('intent persisted before interruption',(await w.app.getGroupBuy(alice,id)));
      } else if(phase==='lost-response') {
        w.payment.timeoutAfterAccept=true;await w.app.tick();assert.equal(w.payment.count(),1);assert.equal((await w.app.getGroupBuy(alice,id)).status,'RECOVERING');log('payment accepted but response lost',(await w.app.getGroupBuy(alice,id)));
      } else {
        assert.equal(phase,'late-success');assert(state.approvalCommand);assert.deepEqual(await w.app.execute(alice,state.approvalCommand),state.approvalResult);
        const submission=(await w.app.getGroupBuy(alice,id)).payment!.submissionId;w.payment.setStatus(submission,{state:'SUCCEEDED',unresolvedFunds:false});await w.app.tick();await w.app.tick();assert.equal(w.payment.count(),1);assert.equal((await w.app.getGroupBuy(alice,id)).status,'COMPLETED');
        const updates=(await w.app.getMyUpdates(alice,state.cursor));assert(updates.items.some(e=>e.type==='group.completed'));assert(updates.nextCursor>state.cursor);log('late success reconciled without resubmission',(await w.app.getGroupBuy(alice,id)));console.log(JSON.stringify({missedEvents:updates.items}));
      }
    }
  } finally {await w.close();}
}
