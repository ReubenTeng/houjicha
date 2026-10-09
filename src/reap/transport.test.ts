import { expect, it } from 'vitest';
import { ReapTransport } from './transport.js';
const base = {baseUrl:'https://sg.sandbox.api.reap.global',apiKey:'test',reapVersion:'2025-02-14',bypassThrottle:true};
it('keeps timeout active through response body consumption', async () => {
  const transport = new ReapTransport({...base,timeoutMs:5,fetchImpl: async (_url, init) => new Response(new ReadableStream({start(controller) {init?.signal?.addEventListener('abort',()=>controller.error(new Error('aborted')));}}))});
  await expect(transport.request({method:'GET',path:'/test'})).rejects.toMatchObject({kind:'timeout'});
});
it.each(['30', new Date(Date.now()+30000).toUTCString()])('parses Retry-After %s', async (retry) => {
  const transport = new ReapTransport({...base,fetchImpl:async()=>new Response('{}',{status:429,headers:{'Retry-After':retry}})});
  await expect(transport.request({method:'GET',path:'/test'})).rejects.toMatchObject({status:429,retryAfterSeconds:expect.any(Number)});
});
