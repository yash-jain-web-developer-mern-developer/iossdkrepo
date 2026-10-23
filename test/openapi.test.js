import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { api } from '../src/api/index.js';

// Minimal parser for the spec's `paths:` block (no YAML dependency): collects "METHOD /path" pairs.
function specOperations() {
  const lines = readFileSync(new URL('../docs/openapi.yaml', import.meta.url), 'utf8').split('\n');
  const start = lines.findIndex((l) => l === 'paths:'), end = lines.findIndex((l, i) => i > start && /^\S/.test(l));
  const ops = new Set(); let path = null;
  for (const l of lines.slice(start + 1, end)) {
    const p = l.match(/^  (\/[^\s:]*):\s*$/); if (p) { path = p[1]; continue; }
    const m = l.match(/^    (get|post|put|patch|delete):/); if (m && path) ops.add(`${m[1].toUpperCase()} ${path}`);
  }
  return ops;
}

test('every implemented API route is documented in docs/openapi.yaml (and nothing documented is missing from the code)', () => {
  const handler = api({ repo: {}, catalog: {}, cfg: {}, keys: {}, notify: {}, mailer: {}, authLimiter: {}, strictLimiter: {}, ledger: {} });
  const implemented = new Set(handler.routeKeys);
  for (const adRoute of ['POST /v1/ad', 'POST /rtb/v2.6/bid','GET /t/i/{token}', 'GET /t/c/{token}', 'GET /t/x/{token}', 'GET /t/v/{token}', 'GET /t/w/{token}', 'POST /v1/conversion', 'GET /v1/test/pixel', 'GET /v1/test/click']) implemented.add(adRoute); // served by the ad plane
  implemented.add('GET /metrics'); // served by the server shell
  const documented = specOperations();
  const undocumented = [...implemented].filter((r) => !documented.has(r));
  const phantom = [...documented].filter((r) => !implemented.has(r));
  assert.deepEqual(undocumented, [], 'routes missing from the OpenAPI spec');
  assert.deepEqual(phantom, [], 'spec documents routes that do not exist');
  assert.ok(implemented.size > 40);
});
