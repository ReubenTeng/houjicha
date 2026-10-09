// Synthetic, authenticated-at-the-application-seam actors. Not an authentication adapter.
import { randomUUID } from 'node:crypto';
import type { Authorization, BasketInput, Collection, Constraints, CreateInput } from './contract.js';
import { Orchestration } from './application.js';
import { DemoAuthorization, FakeCatalog, FakeClock, FakePayment } from './fakes.js';
import { SqliteStore } from './store.js';
export const collection: Collection={point:{label:'LOCAL_MOCK collection',address:'Synthetic address',latitude:1.3,longitude:103.8},window:{startsAt:'2030-01-02T10:00:00Z',endsAt:'2030-01-02T12:00:00Z',timeZone:'Asia/Singapore'}};
export const joiningDeadline='2030-01-01T00:30:00Z';
export function demoWorld(path: string) {
  const clock=new FakeClock(); const store=new SqliteStore(path); const catalog=new FakeCatalog(); const payment=new FakePayment(path,clock); const grants=new DemoAuthorization();
  const app=new Orchestration(store,catalog,payment,grants,clock);
  function input(userId: string, action: 'HOST'|'JOIN', max='1150', offered=collection, variantId='tea'): CreateInput {
    const constraints: Constraints={maxTotal:{currency:'USD',minor:max},origin:{latitude:1.3,longitude:103.8},maxDistanceMeters:10000,availabilityWindow:{startsAt:'2030-01-02T00:00:00Z',endsAt:action==='HOST' && Date.parse(offered.window.endsAt)>Date.parse('2030-01-03T00:00:00Z')?offered.window.endsAt:'2030-01-03T00:00:00Z',timeZone:'Asia/Singapore'}};
    const grant: Authorization={authorizationId:`local-mock-grant:${randomUUID()}`,userId,action,merchantId:'merchant',lines:[{variantId,quantity:1}],constraints,collection:offered,...(action==='HOST'?{joiningDeadline}:{})};
    const authorizationRef=grants.record(grant);
    return {merchantId:'merchant',lines:grant.lines,constraints,authorizationRef,collection:offered,joiningDeadline};
  }
  function basket(userId: string,max='1150',offered=collection,variantId='tea'): BasketInput {const {lines,constraints,authorizationRef}=input(userId,'JOIN',max,offered,variantId);return {lines,constraints,authorizationRef};}
  return {clock,store,catalog,payment,grants,app,input,basket,close:()=>{payment.close();store.close();}};
}
