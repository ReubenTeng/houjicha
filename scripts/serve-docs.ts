import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const port = Number(process.env['DOCS_PORT'] ?? 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid DOCS_PORT');
const assets = new Map([
  ['/assets/swagger-ui.css', { file: require.resolve('swagger-ui-dist/swagger-ui.css'), type: 'text/css' }],
  ['/assets/swagger-ui-bundle.js', { file: require.resolve('swagger-ui-dist/swagger-ui-bundle.js'), type: 'application/javascript' }],
  ['/openapi.json', { file: new URL('../docs/reap-wrapper.openapi.json', import.meta.url), type: 'application/json' }],
  ['/contract', { file: new URL('../docs/reap-wrapper-api.md', import.meta.url), type: 'text/plain; charset=utf-8' }],
]);
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>GroupCart Reap Wrapper — Swagger</title><link rel="stylesheet" href="/assets/swagger-ui.css">
<style>body{margin:0;background:#fafafa}.notice{font:15px/1.5 system-ui;padding:16px 24px;background:#fff;border-bottom:1px solid #ddd}.notice a{margin-right:20px}</style>
</head><body><div class="notice"><strong>GroupCart · TypeScript API contract</strong><br>
Documentation preview. Merchant and payment operations are not implemented by this server.<br>
<a href="/openapi.json" download="reap-wrapper.openapi.json">Download OpenAPI</a><a href="/contract">Engineering handoff</a></div>
<div id="swagger-ui"></div><script src="/assets/swagger-ui-bundle.js"></script><script>
window.ui = SwaggerUIBundle({url:'/openapi.json',dom_id:'#swagger-ui',deepLinking:true,
displayOperationId:true,filter:true,defaultModelsExpandDepth:0,docExpansion:'list',
supportedSubmitMethods:[],validatorUrl:null,persistAuthorization:false});
</script></body></html>`;
const server = createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end('Documentation server only');
    return;
  }
  const asset = assets.get(path);
  if (path !== '/' && path !== '/docs' && !asset) {
    response.writeHead(404).end('Not found');
    return;
  }
  try {
    const body = asset ? readFileSync(asset.file) : html;
    response.writeHead(200, { 'Content-Type': asset?.type ?? 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch {
    response.writeHead(500).end('Missing docs asset. Run npm install and npm run docs:generate.');
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Swagger UI: http://127.0.0.1:${port}/docs`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close());
