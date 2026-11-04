import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { Server } from "@modelcontextprotocol/server";
import { discoverTools, withRemoteClient, listAllTools } from '../dist/discover-tools.js';

// Synthetic credentials and tools only; these tests never contact Buffer.
const key = 'fixture-credential-not-real';
const tool = (name) => ({ name, inputSchema: { type: 'object', properties: {} } });

async function serve(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return new URL(`http://127.0.0.1:${server.address().port}/mcp`);
}

async function mockMcp(t, list) {
  return serve(t, async (req, res) => {
    if (req.headers.authorization !== `Bearer ${key}`) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const server = new Server({ name: 'fixture', version: '1.0.0' }, {
      capabilities: { tools: {} },
    });
    // No tool-call handler: discovery must succeed without executing a tool.
    server.setRequestHandler('tools/list', list);
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => { void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
}

test('negotiates real MCP HTTP and collects every tool-discovery page', async (t) => {
  const cursors = [];
  const url = await mockMcp(t, (request) => {
    cursors.push(request.params?.cursor);
    return request.params?.cursor === 'second'
      ? { tools: [tool('list_channels')] }
      : { tools: [tool('get_account')], nextCursor: 'second' };
  });
  const tools = await discoverTools(url, key);
  assert.deepEqual(tools.map((item) => item.name), ['get_account', 'list_channels']);
  assert.deepEqual(cursors, [undefined, 'second']);
});

test('rejects missing credentials before making a connection', async () => {
  await assert.rejects(discoverTools(new URL('http://127.0.0.1:1'), '  '), /Set BUFFER_API_KEY/);
});

test('reports authentication rejection without reflecting a secret response body', async (t) => {
  const url = await serve(t, (_req, res) => { res.writeHead(401).end(key); });
  await assert.rejects(discoverTools(url, key), (error) => {
    assert.match(error.message, /401/);
    assert.ok(!error.message.includes(key));
    return true;
  });
});

test('reports Retry-After on 429 without retrying or inventing a quota window', async (t) => {
  let requests = 0;
  const url = await serve(t, (_req, res) => {
    requests++;
    res.writeHead(429, { 'Retry-After': '120' }).end();
  });
  await assert.rejects(discoverTools(url, key), /Retry after 120 seconds.*window is unknown/);
  assert.equal(requests, 1);
});

test('bounds a stalled connection', async (t) => {
  const url = await serve(t, () => {});
  await assert.rejects(discoverTools(url, key, 100), /timed out/);
});

for(const [status,code] of [[401,'AUTH_REQUIRED'],[403,'FORBIDDEN'],[429,'RATE_LIMITED'],[500,'UPSTREAM_ERROR']]){
  test(`modern discovery preserves HTTP ${status} classification through SDK negotiation without reflecting raw bodies`,async(t)=>{
    let calls=0;
    const url=await serve(t,(_req,res)=>{calls++;res.writeHead(status,{'Retry-After':'12','RateLimit':'"daily";r=0','RateLimit-Policy':'"daily";w=86400'}).end('synthetic-private-upstream-body');});
    await assert.rejects(withRemoteClient(url,{label:'Fixture',credentialEnv:'none',headers:{}},listAllTools),error=>{
      assert.equal(error.details.code,code);assert.doesNotMatch(error.message,/synthetic-private-upstream-body|protocol negotiation failed/);
      if(status===429){assert.equal(error.details.retryAfterSeconds,12);assert.equal(error.details.windowSeconds,86400);}
      return true;
    });assert.equal(calls,1);
  });
}

test('a shared deadline expiring is reported as timeout rather than user cancellation', async (t) => {
  const url = await serve(t, () => {});
  await assert.rejects(withRemoteClient(url, { label: 'Fixture', credentialEnv: 'FIXTURE', headers: {} },
    listAllTools, 1000, AbortSignal.timeout(40)), (error) => error.details.code === 'TIMEOUT');
});

test('rejects an upstream pagination loop', async (t) => {
  const url = await mockMcp(t, () => ({ tools: [], nextCursor: 'repeated' }));
  await assert.rejects(discoverTools(url, key), /pagination/);
});

test('empty catalogue is a valid discovery result', async (t) => {
  const url = await mockMcp(t, () => ({ tools: [] }));
  assert.deepEqual(await discoverTools(url, key), []);
});

test('entry point exits with a useful message when the key is absent', () => {
  const env = { ...process.env };
  delete env.BUFFER_API_KEY;
  const result = spawnSync(process.execPath, ['dist/buffer-tools.js'], {
    env, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Set BUFFER_API_KEY/);
  assert.equal(result.stdout, '');
});
