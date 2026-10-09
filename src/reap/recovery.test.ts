import { expect, it } from 'vitest';
import { createDemoReapWrapper } from './demo.js';
import type { ManagedReapWrapper } from './config.js';
import type { Result, WalletDebitInput } from './contract.js';
const unwrap = <T>(r:Result<T>):T => {if(!r.ok)throw new Error(JSON.stringify(r.error));return r.data;};
const ctx=(id:string)=>({operationId:id,idempotencyKey:id});
const user='mock_user_reuben';
async function ready(w:ManagedReapWrapper):Promise<WalletDebitInput> {
  unwrap(await w.searchProducts({query:'coffee',country:'SG',currency:'USD'}));
  unwrap(await w.getProductDetails(['mock_product_coffee']));
  const q=unwrap(await w.createQuote({groupOrderId:'group',basketRevision:1,storeId:'mock_store_demo',currency:'USD',email:'test@example.com',shippingAddress:{firstName:'Test',lastName:'User',phone:'+12025550100',addressLine1:'1 Street',city:'Singapore',country:'SG'},lines:[{variantId:'mock_variant_coffee',quantity:1}]},ctx('quote')));
  const e=unwrap(await w.createEnrollment({userId:user,email:'test@example.com',returnUrl:`https://groupcart.example/return?state=enroll:${user}`},ctx('enroll')));
  const c=unwrap(await w.createCheckout({groupOrderId:'group',purchaseAttemptId:'purchase',quoteId:q.quoteId,expectedFingerprint:q.fingerprint,purchaserUserId:user,enrollmentId:e.enrollmentId,approvedTotal:q.amountBreakdown.finalAmount,returnUrl:`https://groupcart.example/return?state=checkout:${user}`},ctx('checkout')));
  return {groupOrderId:'group',checkoutId:c.checkoutId,participantId:user,userId:user,allocationId:'alloc',consentRef:`mock-consent:alloc:${user}`,amount:q.amountBreakdown.finalAmount,approvedAmount:q.amountBreakdown.finalAmount};
}
it.each([408,409,500])('never retries unknown debit after HTTP %s',async status=>{
  let posts=0;
  const w=createDemoReapWrapper({intercept: provider=>async(url,init)=>{if(String(url).includes('/postings/')&&init?.method==='POST'){posts++;return new Response('{}',{status});}return provider(url,init);}});
  try {
    const input=await ready(w); expect(await w.debitWallet(input,ctx('debit'))).toMatchObject({ok:false,error:{outcome:'UNKNOWN'}});
    const op=unwrap(await w.getOperation('debit')); expect(op.state).toBe('UNKNOWN'); expect(op.resourceId).not.toBeNull();
    expect(unwrap(await w.getWalletDebit(op.resourceId!)).state).toBe('UNKNOWN');
    expect(await w.retryWalletDebit(op.resourceId!,ctx('retry'))).toMatchObject({ok:false,error:{code:'DEBIT_OUTCOME_UNKNOWN'}});expect(posts).toBe(1);
  }finally{await w.close();}
});
it('retries a definitive rejection with a new operation',async()=>{
  let posts=0;const w=createDemoReapWrapper({intercept:provider=>async(url,init)=>{if(String(url).includes('/postings/')&&init?.method==='POST'&&++posts===1)return new Response('{}',{status:422});return provider(url,init);}});
  try{const input=await ready(w);expect((await w.debitWallet(input,ctx('debit'))).ok).toBe(false);const op=unwrap(await w.getOperation('debit'));expect(unwrap(await w.getWalletDebit(op.resourceId!)).state).toBe('REJECTED');expect(unwrap(await w.retryWalletDebit(op.resourceId!,ctx('retry'))).state).toBe('APPLIED');expect(posts).toBe(2);}finally{await w.close();}
});
it('rejects product merchant changes',async()=>{
  const w=createDemoReapWrapper({intercept:provider=>async(url,init)=>{const response=await provider(url,init);if(String(url).endsWith('/details')){const body=await response.json() as {products:{merchant:{name:string}}[]};body.products[0]!.merchant.name='Impostor';return Response.json(body);}return response;}});
  try{unwrap(await w.searchProducts({query:'coffee',country:'SG',currency:'USD'}));expect((await w.getProductDetails(['mock_product_coffee'])).ok).toBe(false);}finally{await w.close();}
});
