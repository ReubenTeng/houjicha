import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import SwaggerParser from '@apidevtools/swagger-parser';

const file = new URL('../docs/reap-wrapper.openapi.json', import.meta.url);
await SwaggerParser.validate(file.pathname);
const spec = JSON.parse(readFileSync(file, 'utf8'));
const contract = readFileSync(new URL('../docs/reap-wrapper-contract.ts', import.meta.url), 'utf8');
const methods = [...contract.slice(contract.indexOf('export interface ReapWrapper')).matchAll(/^  (\w+)\(/gm)].map(match => match[1]);
const operations = Object.values(spec.paths).flatMap((path: any) => Object.values(path)) as any[];
assert.deepEqual(operations.map(op => op.operationId).sort(), methods.sort(), 'Swagger must document every wrapper method exactly once');
for (const operation of operations) {
  if (operation.responses['202']) {
    const refs = operation.parameters.map((parameter: any) => parameter.$ref);
    assert(refs.includes('#/components/parameters/OperationId'));
    assert(refs.includes('#/components/parameters/IdempotencyKey'));
  }
}
assert.equal(spec.components.schemas.QuoteInput.properties.lines.maxItems, 20);
assert.equal(spec.components.schemas.ProductDetailsInput.properties.productIds.maxItems, 10);
assert.equal(spec.components.schemas.Money.properties.minor.type, 'string');
console.log(`Valid OpenAPI 3.1: ${operations.length} operations, all TypeScript methods covered.`);
