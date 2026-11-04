import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Server, createMcpHandler } from '@modelcontextprotocol/server';
import { verifyBigQueryMetadata } from '../scripts/verify-bigquery-metadata.mjs';
import { withRemoteClient } from '../dist/discover-tools.js';
import { discoverBigQueryPublicTools } from '../dist/bigquery-discovery.js';

const tool = { name: 'list_dataset_ids', inputSchema: {
  type: 'object', additionalProperties: false, required: ['projectId'], properties: { projectId: { type: 'string' } },
} };
const legacy = request => request.method === 'initialize' ? Response.json({ jsonrpc: '2.0', id: request.id, result: {
  protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'google-shaped-fixture', version: '0' },
} }) : request.method === 'notifications/initialized' ? new Response(null, { status: 204 }) : undefined;

test('BigQuery public probe proves standard legacy SDK compatibility while retaining the failed modern comparison', async () => {
  const methods = [];
  const evidence = await verifyBigQueryMetadata(async (url, init) => {
    assert.equal(String(url), 'https://bigquery.googleapis.com/mcp');
    assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
    assert.equal(new Headers(init.headers).has('Authorization'), false); assert.ok(init.signal instanceof AbortSignal);
    const request = JSON.parse(init.body); methods.push(request.method);
    return legacy(request) ?? Response.json({ jsonrpc: '2.0', id: request.id,
      ...(request.method === 'tools/list' ? { result: { tools: [tool] } }
        : { error: { code: -32601, message: 'private diagnostic must not escape' } }) });
  });
  assert.deepEqual(methods, ['tools/list','server/discover','initialize','notifications/initialized','tools/list',
    'initialize','notifications/initialized','tools/list']);
  assert.equal(evidence.sdkCompatible, true); assert.equal(evidence.protocol, '2025-11-25');
  assert.equal(evidence.checks.officialSdkModernDiscovery, false); assert.equal(evidence.checks.officialSdkLegacyDiscovery, true);
  assert.equal(evidence.discoveryErrorCode, -32601);
  assert.deepEqual(evidence.nativeSdk, { discoveryOnly: true, resultRewriting: false, compiledSchemas: 1,
    gatewayDiscovery: true, authenticatedOperationsVerified: false });
  assert.deepEqual(evidence.tools, ['list_dataset_ids']); assert.ok(!JSON.stringify(evidence).includes('private diagnostic'));
});

test('BigQuery probe recognizes a compatible modern SDK endpoint when its handshake is supported (fixture)', async t => {
  const handler = createMcpHandler(() => {
    const server = new Server({ name: 'public-fixture', version: '0' }, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/list', () => ({ tools: [tool] })); return server;
  }); t.after(() => handler.close());
  const evidence = await verifyBigQueryMetadata(async (url, init) => {
    const request = JSON.parse(init.body);
    if (request.id === 'public-tools-list') return Response.json({ jsonrpc: '2.0', id: request.id, result: { tools: [tool] } });
    return handler.fetch(new Request(url, init));
  });
  assert.equal(evidence.sdkCompatible, true); assert.equal(evidence.checks.officialSdkModernDiscovery, true);
  assert.equal(evidence.modernFailure, undefined);
});

test('BigQuery public discovery uses real legacy initialization and preserves schemas and pagination without response rewriting', async () => {
  let pages = 0; const methods = [];
  const first = { ...tool, annotations: { readOnlyHint: true } };
  const result = await discoverBigQueryPublicTools({ fetch: async (url, init) => {
    assert.equal(String(url), 'https://bigquery.googleapis.com/mcp'); assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error'); assert.equal(new Headers(init.headers).has('authorization'), false);
    const request = JSON.parse(init.body); methods.push(request.method);
    const handshake = legacy(request); if (handshake) return handshake;
    assert.equal(request.method, 'tools/list'); assert.equal(new Headers(init.headers).get('mcp-protocol-version'), '2025-11-25');
    pages++;
    assert.equal(request.params?.cursor, pages === 1 ? undefined : 'page2');
    return Response.json({ jsonrpc: '2.0', id: request.id, result: pages === 1
      ? { tools: [first], nextCursor: 'page2' } : { tools: [{ ...tool, name: 'get_job' }] } });
  } });
  assert.deepEqual(result, { tools: [first, { ...tool, name: 'get_job' }], protocolVersion: '2025-11-25' });
  assert.deepEqual(methods, ['initialize','notifications/initialized','tools/list','tools/list']);
});

test('BigQuery legacy discovery refuses malformed and ambiguous result kinds rather than guessing success', async () => {
  for (const result of [{ tools: 'invalid' }, { tools: [tool], inputRequests: {} },
    { tools: [tool], resultType: 'future' }, { tools: [tool], resultType: 1 }]) {
    await assert.rejects(discoverBigQueryPublicTools({ fetch: async (_url, init) => {
      const request = JSON.parse(init.body); return legacy(request) ?? Response.json({ jsonrpc: '2.0', id: request.id, result });
    } }), e => e.details?.code === 'UPSTREAM_ERROR');
  }
});

test('BigQuery SDK discovery preserves JSON-RPC errors as safe failures', async () => {
  await assert.rejects(discoverBigQueryPublicTools({ fetch: async (_url, init) => {
    const request = JSON.parse(init.body); return legacy(request) ?? Response.json({ jsonrpc: '2.0', id: request.id,
      error: { code: -32601, message: 'private-error-content' } });
  } }), e => e.details?.code === 'UPSTREAM_ERROR' && !e.message.includes('private-error-content'));
});

test('BigQuery SDK discovery rejects repeated cursors and duplicate tools', async () => {
  for (const duplicate of [false, true]) {
    let pages = 0;
    await assert.rejects(discoverBigQueryPublicTools({ fetch: async (_url, init) => {
      const request = JSON.parse(init.body); const handshake = legacy(request); if (handshake) return handshake; pages++;
      return Response.json({ jsonrpc: '2.0', id: request.id, result: {
        tools: duplicate ? [tool,tool] : [{ ...tool, name: `tool${pages}` }], ...(duplicate ? {} : { nextCursor: 'same' }),
      } });
    } }));
    assert.equal(pages, duplicate ? 1 : 2);
  }
});

test('BigQuery discovery preserves rate-limit recovery and never retries failed requests', async () => {
  let calls = 0;
  await assert.rejects(discoverBigQueryPublicTools({ fetch: async () => { calls++;
    return new Response('private-error-content', { status: 429, headers: { 'Retry-After': '12' } });
  } }), e => e.details?.code === 'RATE_LIMITED' && e.details.retryAfterSeconds === 12 && !e.message.includes('private-error-content'));
  assert.equal(calls, 1);
});

test('BigQuery discovery honors pre-cancellation and a shared deadline', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(discoverBigQueryPublicTools({ signal: controller.signal, fetch: async () => {
    calls++; throw new Error('must not send');
  } }), e => e.details?.code === 'CANCELLED'); assert.equal(calls, 0);
  await assert.rejects(discoverBigQueryPublicTools({ timeoutMs: 20, fetch: (_url, init) => new Promise((_, reject) => {
    const keepAlive = setTimeout(() => reject(new Error('deadline not honored')), 1000);
    init.signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(init.signal.reason); }, { once: true });
  }) }), e => e.details?.code === 'TIMEOUT');
});

test('BigQuery discovery stops an unfinished catalogue after exactly 100 pages', async () => {
  let pages = 0;
  await assert.rejects(discoverBigQueryPublicTools({ fetch: async (_url, init) => {
    const request = JSON.parse(init.body); const handshake = legacy(request); if (handshake) return handshake; pages++;
    return Response.json({ jsonrpc: '2.0', id: request.id, result: { tools: [{ ...tool, name: `tool${pages}` }], nextCursor: `page${pages}` } });
  } })); assert.equal(pages, 100);
});

test('BigQuery discovery never accepts a catalogue for another JSON-RPC request ID', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(discoverBigQueryPublicTools({ timeoutMs: 20, fetch: async (_url, init) => {
      const request = JSON.parse(init.body); return legacy(request) ?? Response.json({ jsonrpc: '2.0', id: 'wrong-id', result: { tools: [tool] } });
    } }), e => e.details?.code === 'TIMEOUT');
  } finally { clearTimeout(keepAlive); }
});

test('public probe refuses malformed raw catalogue envelopes and unfinished pages before SDK discovery', async () => {
  for (const value of [{ jsonrpc: '2.0', id: 'wrong', result: { tools: [tool] } },
    { jsonrpc: '2.0', id: 'public-tools-list', result: { tools: [tool], nextCursor: 'next' } }]) {
    let calls = 0; await assert.rejects(verifyBigQueryMetadata(async () => { calls++; return Response.json(value); })); assert.equal(calls, 1);
  }
});

test('pinned modern protocol mismatch is actionable and never dispatches an operation', async () => {
  let requests = 0, operations = 0;
  await assert.rejects(withRemoteClient(new URL('https://example.invalid/mcp'), {
    label: 'Fixture', credentialEnv: 'none', headers: {}, protocol: '2026-07-28', fetch: async (_url, init) => {
      requests++; const request = JSON.parse(init.body); assert.equal(request.method, 'server/discover');
      return Response.json({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'hidden-upstream-body' } });
    },
  }, async () => { operations++; }), e => /protocol negotiation failed/.test(e.message) && !e.message.includes('hidden-upstream-body'));
  assert.equal(requests, 1); assert.equal(operations, 0);
});

test('BigQuery outer timeout remains a timeout and duplicate names cannot escape discovery', async () => {
  const controller = new AbortController(); controller.abort(new DOMException('fixture timeout', 'TimeoutError'));
  await assert.rejects(discoverBigQueryPublicTools({ signal: controller.signal }), e => e.details?.code === 'TIMEOUT');
  await assert.rejects(discoverBigQueryPublicTools({ fetch: async (_url, init) => {
    const request = JSON.parse(init.body); return legacy(request) ?? Response.json({ jsonrpc: '2.0', id: request.id, result: { tools: [tool,tool] } });
  } }));
});
