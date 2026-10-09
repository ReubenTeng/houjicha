import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const port = Number(process.env['DOCS_PORT'] ?? 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid DOCS_PORT');
const assets = new Map([
  ['/reap-wrapper-api.md', { file: new URL('../docs/reap-wrapper-api.md', import.meta.url), type: 'text/plain; charset=utf-8' }],
  ['/reap-wrapper-contract.ts', { file: new URL('../docs/reap-wrapper-contract.ts', import.meta.url), type: 'text/plain; charset=utf-8' }],
]);
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
    const body = asset ? readFileSync(asset.file) : readFileSync(new URL('../docs/reap-wrapper-reference.html', import.meta.url));
    response.writeHead(200, { 'Content-Type': asset?.type ?? 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch {
    response.writeHead(500).end('Missing docs asset. Run npm install and npm run docs:generate.');
  }
});
server.listen(port, '127.0.0.1', () => console.log(`API reference: http://127.0.0.1:${port}/docs`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close());
