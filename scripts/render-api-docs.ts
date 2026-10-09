// A standalone reference page: native HTML disclosures, no Swagger runtime.
type Schema = Record<string, any>;
const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export function renderApiDocs(reference: Schema): string {
  const resolve = (schema: Schema): Schema => schema.$ref
    ? reference.schemas[schema.$ref.split('/').at(-1)] ?? schema : schema;
  const type = (schema: Schema): string => {
    if (schema.$ref) { const target = resolve(schema); return target === schema || target.properties ? decodeURIComponent(schema.$ref.split('/').at(-1)) : type(target); }
    if (schema.const !== undefined) return JSON.stringify(schema.const);
    if (schema.enum) return schema.enum.map((v: unknown) => JSON.stringify(v)).join(' | ');
    if (schema.anyOf || schema.oneOf) return (schema.anyOf ?? schema.oneOf).map(type).join(' | ');
    if (schema.allOf) return schema.allOf.map(type).join(' & ');
    return schema.type === 'array' ? `${type(schema.items)}[]` : schema.type ?? 'object';
  };
  const fields = (input: Schema, seen: string[] = []): string => {
    if (input.$ref && seen.includes(input.$ref)) return `<code>${escape(type(input))}</code>`;
    const next = input.$ref ? [...seen, input.$ref] : seen;
    const schema = resolve(input);
    if (schema.anyOf || schema.oneOf || schema.allOf) return (schema.anyOf ?? schema.oneOf ?? schema.allOf).map((s: Schema) => fields(s, next)).join('');
    if (schema.type === 'array') return fields(schema.items, next);
    if (!schema.properties) return `<code>${escape(type(schema))}</code>`;
    return `<div class="table-scroll"><table><thead><tr><th>Field</th><th>Type</th><th>Details</th></tr></thead><tbody>${Object.entries(schema.properties).map(([name, raw]) => {
      const value = raw as Schema;
      const detail = resolve(value);
      const constraints = ['minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'format'].filter(key => detail[key] !== undefined).map(key => `${key}: ${detail[key]}`).join('; ');
      const nested = detail.properties || detail.items || detail.anyOf || detail.oneOf || detail.allOf;
      return `<tr><td><code>${escape(name)}</code>${schema.required?.includes(name) ? '<small class="required">required</small>' : '<small>optional</small>'}</td><td><code>${escape(type(value))}</code></td><td>${escape(value.description ?? detail.description ?? '')}<small>${escape(constraints)}</small>${nested ? `<details class="nested"><summary>Fields</summary>${fields(value, next)}</details>` : ''}</td></tr>`;
    }).join('')}</tbody></table></div>`;
  };
  const groups = [...new Set<string>(reference.functions.map((fn: Schema) => fn.tag))].map(group => `<section><h2>${escape(group)} service</h2>${reference.functions.filter((fn: Schema) => fn.tag === group).map((fn: Schema) => `<details class="function ${fn.mutation ? 'command' : 'query'}" id="${escape(fn.id)}"><summary><span class="kind">${fn.mutation ? 'COMMAND' : 'QUERY'}</span><code>${escape(fn.id)}()</code><span class="summary">${escape(fn.summary)}</span></summary><div class="body"><h3>Signature</h3><pre>${escape(fn.signature)}</pre><p>${escape(fn.description)}</p><h3>Arguments</h3>${fields(fn.arguments)}<h3>Resolved return value</h3><p>Await the promise and check <code>result.ok</code>. Success contains <code>data</code>; failure contains <code>error</code>.</p>${fields(fn.returns)}<h3>Failure and recovery</h3><p>Expected failures resolve to <code>Failure</code>. Branch on <code>error.code</code>, <code>outcome</code> and <code>recovery</code>. ${fn.mutation ? 'Persist context before calling. An UNKNOWN outcome requires recovering the same operation before any replacement command.' : 'Use the returned recovery instruction; unknown values must not be treated as success.'} Unexpected runtime exceptions can reject the promise.</p></div></details>`).join('')}</section>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>GroupCart · Internal service interface</title><style>
*{box-sizing:border-box}body{margin:0;background:#fafafa;color:#263342;font:15px/1.55 system-ui,sans-serif}main{max-width:1180px;margin:auto;padding:40px 24px 80px}header{border-bottom:1px solid #d7dee5;padding-bottom:26px}h1{font-size:32px;margin:8px 0}h2{margin:36px 0 14px;font-size:23px}h3{font-size:16px;margin-top:24px}a{color:#176fa0}code,pre{font-family:ui-monospace,monospace;font-size:13px}pre{background:#1c2632;color:#ecf1f6;padding:20px;border-radius:4px;overflow:auto;white-space:pre-wrap}small{display:block;color:#647386;font-size:12px}.eyebrow{font-size:12px;letter-spacing:1.4px;text-transform:uppercase;color:#647386}.intro{max-width:850px}.function{margin:12px 0;border:1px solid var(--color);border-radius:5px;background:var(--bg)}.query{--color:#4a99d3;--bg:#f0f7fc}.command{--color:#39a77a;--bg:#eff9f4}.function>summary{display:flex;align-items:center;gap:15px;padding:13px;cursor:pointer;list-style:none}.function>summary:after{content:'⌄';margin-left:auto}.function[open]>summary:after{content:'⌃'}.kind{background:var(--color);color:white;border-radius:3px;padding:4px 10px;min-width:90px;text-align:center;font-size:11px;font-weight:700}.summary{font-size:14px;color:#526172}.body{border-top:1px solid var(--color);padding:20px;background:#fff}.table-scroll{overflow:auto}table{border-collapse:collapse;width:100%;text-align:left;margin:12px 0}th,td{padding:12px;border-bottom:1px solid #e1e7ed;vertical-align:top}th{font-size:12px;text-transform:uppercase;color:#647386}td:nth-child(1){min-width:145px}td:nth-child(2){min-width:160px}td code{overflow-wrap:anywhere}.required{color:#ab4235}.nested{margin:12px 0;border:1px solid #dce3e9;border-radius:4px;padding:12px}.nested summary{cursor:pointer}summary:focus-visible,a:focus-visible{outline:3px solid #d49b29;outline-offset:3px}@media(max-width:700px){main{padding:24px 12px}.function>summary{flex-wrap:wrap;gap:8px}.summary{flex-basis:100%}.body{padding:12px}h1{font-size:26px}}
</style></head><body><main><header><div class="eyebrow">GroupCart · Engineer handoff · TypeScript</div><h1>Internal service interface</h1><p class="intro">Engineer A owns orchestration. Engineer B implements <code>ReapWrapper</code>. A receives the service through dependency injection and calls these asynchronous functions directly. The groups organize responsibilities within one module.</p><p><a href="reap-wrapper-api.md">Engineering handoff and provider research</a> · <a href="reap-wrapper-contract.ts">TypeScript interface</a></p><p>20 functions · Arguments · Return types · Preconditions · Recovery</p><h3>Calling the service</h3><pre>import type { ReapWrapper } from './reap-wrapper-contract.js';

async function checkWallet(reap: ReapWrapper, userId: string) {
  const result = await reap.getWallet(userId);
  if (!result.ok) {
    return { error: result.error.code, recovery: result.error.recovery };
  }
  return result.data;
}</pre><p>Queries read state. Commands may change provider or wrapper state and require <code>MutationContext</code>. Successful return values still require checking resource state before treating a purchase or debit as complete. Types describe a proposed contract; live provider behavior remains subject to verification.</p></header>${groups}</main><script>function reveal(){const id=location.hash.split('/').pop()?.replace(/^#/,'');const el=document.getElementById(id);if(el){el.open=true;el.scrollIntoView();}}addEventListener('hashchange',reveal);reveal();</script></body></html>\n`;
}
