import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { loadConnection } from '../dist/connections.js';
import { createSocialGateway } from '../dist/gateway.js';
import { verifyService } from '../dist/verify-service.js';
import { canonicalInputSchema } from '../integrations/quickbooks/schema-comparison.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const profile = JSON.parse(await readFile(new URL('../integrations/quickbooks/connection.json', import.meta.url), 'utf8'));
const launcher = resolve(root, 'integrations/quickbooks/run.mjs');
const preload = fileURLToPath(new URL('./quickbooks-fixture-network.mjs', import.meta.url));

function minimal(schema) {
  if (schema.default !== undefined) return schema.default;
  if (schema.enum) return schema.enum[0];
  if (schema.type === 'object') return Object.fromEntries((schema.required ?? []).map((name) => [name, minimal(schema.properties[name])]));
  if (schema.type === 'array') return [];
  if (schema.type === 'boolean') return false;
  if (schema.type === 'integer' || schema.type === 'number') return Math.max(1, schema.minimum ?? 1);
  return 'synthetic-id';
}

async function main() {
  const home = await mkdtemp(join(tmpdir(),'hstack-quickbooks-runtime-'));
  const store = join(home, '.env'), events = join(home, 'blocked-events');
  const counts = { refreshes: 0, reads: 0, mutations: 0 };
  const companyName = `synthetic-company-${randomUUID()}`;
  let apiStatus = 200;
  const fixture = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const url = new URL(req.url, 'http://fixture.invalid');
    res.setHeader('Content-Type', 'application/json');
    if (req.headers['x-hstack-fixture-origin'] === 'oauth.platform.intuit.com') {
      assert.equal(url.pathname, '/oauth2/v1/tokens/bearer');
      assert.equal(new URLSearchParams(body).get('grant_type'), 'refresh_token');
      counts.refreshes++;
      res.end(JSON.stringify({ access_token: 'synthetic-access', refresh_token: `synthetic-rotated-${counts.refreshes}`,
        token_type: 'bearer', expires_in: 3600, x_refresh_token_expires_in: 8640000 })); return;
    }
    if (req.method !== 'GET') { counts.mutations++; res.writeHead(500).end('{}'); return; }
    counts.reads++;
    assert.equal(req.headers.authorization, 'Bearer synthetic-access');
    if (apiStatus !== 200) { res.writeHead(apiStatus, { 'Retry-After': '2' }).end('{"Fault":{"Error":[{"Message":"synthetic-private-api-error"}]}}'); return; }
    if (url.pathname.endsWith('/companyinfo/synthetic-realm')) res.end(JSON.stringify({ CompanyInfo: { Id: 'synthetic-realm', CompanyName: companyName } }));
    else if (url.pathname.endsWith('/reports/BalanceSheet')) res.end(JSON.stringify({ Header: { ReportName: 'BalanceSheet' }, Columns: {}, Rows: { Row: [] } }));
    else if (url.pathname.endsWith('/query')) res.end('{"QueryResponse":{"Customer":[],"maxResults":0}}');
    else { res.writeHead(404).end('{"Fault":{"Error":[{"Message":"unexpected synthetic route"}]}}'); }
  });
  await new Promise((done) => fixture.listen(0, '127.0.0.1', done));
  const port = String(fixture.address().port);
  const configText = (withTokens) => `QUICKBOOKS_CLIENT_ID=synthetic-client\nQUICKBOOKS_CLIENT_SECRET=synthetic-value\nQUICKBOOKS_ENVIRONMENT=sandbox\nQUICKBOOKS_DISABLE_WRITE=false\nQUICKBOOKS_DISABLE_UPDATE=false\nQUICKBOOKS_DISABLE_DELETE=false\nHSTACK_QUICKBOOKS_NON_INTERACTIVE=false\nHSTACK_QUICKBOOKS_READ_ONLY=false\n${withTokens ? 'QUICKBOOKS_REFRESH_TOKEN=synthetic-refresh\nQUICKBOOKS_REALM_ID=synthetic-realm\n' : ''}`;
  const env = { QUICKBOOKS_TOKEN_STORE_PATH: store, HSTACK_QBO_FIXTURE_PORT: port, HSTACK_QBO_FIXTURE_EVENTS: events };
  const connections = [];
  const openNative = async (args = []) => {
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', preload, launcher, ...args], env, stderr: 'ignore' });
    const client = new Client({ name: 'synthetic-intuit-check', version: '0' });
    connections.push(async () => { await client.close(); await transport.close(); });
    await client.connect(transport, { signal: AbortSignal.timeout(10_000) }); return client;
  };
  const call = (client, name, args) => client.callTool({ name, arguments: args }, { signal: AbortSignal.timeout(10_000) });
  const report = { vendor: 'Intuit QuickBooks MCP', commit: '31a1dd5c3e170e368dbff651abbaf61aabde6ed9',
    build: 'hstack-compat-1', testedRuntime: { node: process.version, platform: process.platform, arch: process.arch },
    evidence: 'Installed vendor process and synthetic loopback OAuth/API only; no live account or financial data.', checks: {} };
  try {
    await writeFile(store, configText(false), { mode: 0o600 }); await writeFile(events, '', { mode: 0o600 });
    const native = await openNative();
    const readonlyTools = (await native.listTools()).tools;
    assert.equal(readonlyTools.length, 71);
    for (const name of profile.readTools) assert.ok(readonlyTools.some((tool) => tool.name === name));
    assert.ok(readonlyTools.every((tool) => !/^(create|update|delete)[_-]/.test(tool.name)));
    for (const name of profile.readTools) {
      const tool = readonlyTools.find((item) => item.name === name);
      const args = minimal(tool.inputSchema);
      if (['search_accounts','search_items','search_invoices'].includes(name)) args.params.criteria = {};
      const result = await call(native, name, args);
      assert.equal(result.isError, true, `Native missing-auth flag: ${name}`);
      assert.match(JSON.stringify(result), /QuickBooks requires foreground sign-in\./, `Native missing-auth response: ${name}`);
    }
    assert.deepEqual(counts, { refreshes: 0, reads: 0, mutations: 0 });
    report.checks.all70ReadSchemasAndMissingAuthErrors = true;
    report.checks.privateFileCannotDisableLaunchPolicy = true;
    report.readonlyNativeToolCount = readonlyTools.length;
    report.reviewedReadCount = profile.readTools.length;
    const all = await openNative(['--allow-native-writes']);
    const allTools = (await all.listTools()).tools;
    assert.equal(allTools.length, 142);
    report.allNativeToolCount = allTools.length;
    const baseline = JSON.parse(await readFile(new URL('../integrations/quickbooks/schema-baseline.json', import.meta.url), 'utf8'));
    assert.equal(baseline.tools.length, allTools.length);
    const differences = [];
    for (const tool of allTools) {
      const before = baseline.tools.find((item) => item.name === tool.name);
      const digest = createHash('sha256').update(JSON.stringify(canonicalInputSchema(tool.inputSchema))).digest('hex');
      if (before?.sha256 !== digest) differences.push(tool.name);
    }
    report.originalSchemaComparison = { compared: allTools.length, changed: differences };
    assert.deepEqual(differences, [], 'Original schema constraints must remain equivalent after the dependency upgrade.');
    report.schemaSha256 = createHash('sha256').update(JSON.stringify(allTools.map(({ name, inputSchema }) => ({ name, inputSchema })))).digest('hex');
    await Promise.all(connections.splice(0).map((close) => close()));
    await writeFile(store, configText(true), { mode: 0o600 }); await chmod(store, 0o600);
    const direct = await openNative();
    const directCompany = await call(direct, 'get_company_info', { params: {} });
    assert.equal(directCompany.isError, undefined);
    assert.ok(JSON.stringify(directCompany).includes(companyName));
    assert.ok((await readFile(store, 'utf8')).includes('synthetic-rotated-'));
    report.checks.nativeRefreshAndPrivatePersistence = true;
    const provider = await loadConnection({ ...profile, commandEnv: undefined, command: process.execPath,
      args: ['--import', preload, launcher], env: Object.fromEntries(Object.keys(env).map((name) => [name, name])) }, env);
    connections.push(() => provider.close());
    assert.deepEqual(provider.tools, readonlyTools);
    const gateway = createSocialGateway([provider]);
    const client = new Client({ name: 'hstack-synthetic-intuit', version: '0' });
    const [a, b] = InMemoryTransport.createLinkedPair(); await gateway.connect(b); await client.connect(a);
    connections.push(async () => { await client.close(); await gateway.close(); });
    const result = await call(client, 'quickbooks__get_company_info', { params: {} });
    assert.deepEqual(result, directCompany);
    const balance = await call(client, 'quickbooks__get_balance_sheet', { params: {} });
    assert.ok(!balance.isError); assert.match(JSON.stringify(balance), /BalanceSheet/);
    const empty = await call(client, 'quickbooks__search_customers', { params: {} });
    assert.ok(!empty.isError); assert.match(JSON.stringify(empty), /Found 0 customers/);
    await verifyService(provider);
    report.checks.directGatewayCompanyEquality = true;
    report.checks.reportLabelsAndGenuineEmptyLists = true;
    report.checks.operationalCompanyVerifier = true;
    const searchGateway = createSocialGateway([provider], { toolMode: 'search' });
    const searchClient = new Client({ name: 'hstack-synthetic-search', version: '0' });
    const [searchA, searchB] = InMemoryTransport.createLinkedPair();
    await searchGateway.connect(searchB); await searchClient.connect(searchA);
    connections.push(async () => { await searchClient.close(); await searchGateway.close(); });
    const controls = await searchClient.listTools(); assert.equal(controls.tools.length, 2);
    const found = await call(searchClient, 'hstack_search_tools', { service: 'quickbooks', query: 'get_company_info', limit: 1 });
    assert.match(JSON.stringify(found), /quickbooks__get_company_info/);
    const searchRead = await call(searchClient, 'hstack_call_tool', { name: 'quickbooks__get_company_info', arguments: { params: {} } });
    assert.deepEqual(searchRead, directCompany);
    report.discoveryComparison = {
      directCatalogueJsonBytes: Buffer.byteLength(JSON.stringify({ tools: readonlyTools })),
      initialSearchCatalogueJsonBytes: Buffer.byteLength(JSON.stringify(controls)),
      firstSearchResultJsonBytes: Buffer.byteLength(JSON.stringify(found)),
      limitation: 'Installed schemas and local fixture read only; no model cost, accuracy, latency or setup-time claim.',
    };
    report.checks.searchModeSchemaAndRead = true;
    for (const status of [403, 429, 500]) {
      apiStatus = status;
      const failure = await call(client, 'quickbooks__get_company_info', { params: {} });
      assert.equal(failure.isError, true); assert.equal(failure._meta.hstack.code, 'UPSTREAM_ERROR');
      assert.doesNotMatch(JSON.stringify(failure), /synthetic-private-api-error/);
    }
    apiStatus = 200;
    const pdfBlocked = await call(client, 'quickbooks__get_invoice_pdf', { params: {} });
    assert.equal(pdfBlocked.isError, true); assert.equal(pdfBlocked._meta.hstack.outcome, 'not_sent');
    const writeAbsent = await call(client, 'quickbooks__create_customer', { params: {} });
    assert.equal(writeAbsent.isError, true); assert.match(JSON.stringify(writeAbsent), /Unknown Hstack tool/);
    if (process.env.HSTACK_TEST_HERMES_ROOT && process.env.HSTACK_TEST_HERMES_PYTHON) {
      const hermesHome = join(home, 'hermes'); await mkdir(hermesHome, { mode: 0o700 });
      const privateConnections = join(home, 'connections.json');
      await writeFile(privateConnections, JSON.stringify({ connections: [{ ...profile, enabled: true,
        commandEnv: undefined, command: process.execPath, args: ['--import', preload, launcher],
        env: Object.fromEntries(Object.keys(env).map((name) => [name, name])) }] }), { mode: 0o600 });
      await writeFile(join(hermesHome, 'config.yaml'), JSON.stringify({ mcp_servers: { hstack: {
        command: process.execPath, args: [resolve(root, 'dist/server.js')], connect_timeout: 15, timeout: 15,
        sampling: { enabled: false }, env: { ...env, HSTACK_CONNECTIONS_FILE: privateConnections, HSTACK_TOOL_MODE: 'search' },
      } } }), { mode: 0o600 });
      const probe = join(home, 'hermes-probe.json');
      await writeFile(probe, JSON.stringify({ source: process.env.HSTACK_TEST_HERMES_ROOT, companyName }), { mode: 0o600 });
      const result = await promisify(execFile)(process.env.HSTACK_TEST_HERMES_PYTHON,
        ['-I', '-B', fileURLToPath(new URL('./verify-hermes-quickbooks.py', import.meta.url)), probe], {
          env: { PATH: process.env.PATH, HOME: home, HERMES_HOME: hermesHome, PYTHON_DOTENV_DISABLED: '1' }, cwd: home, timeout: 60_000,
        });
      assert.match(result.stdout, /PASS: native Hermes registry/);
      report.checks.nativeHermesRegistrySearchReadAndWriteBlock = true;
      report.hermesMcpSourceSha256 = createHash('sha256').update(await readFile(join(process.env.HSTACK_TEST_HERMES_ROOT, 'tools/mcp_tool.py'))).digest('hex');
    }
    assert.equal(counts.mutations, 0); assert.equal(await readFile(events, 'utf8'), '');
    report.checks.nativeApiErrorsAreSafeFailures = true;
    report.checks.writesAndPdfDownloadBlocked = true;
    report.checks.networkAndBrowserIsolation = true;
    report.fixtureRequests = counts;
    console.log(JSON.stringify(report, null, 2));
  } finally {
    for (const close of connections.reverse()) await close().catch(() => {});
    fixture.closeAllConnections(); await new Promise((done) => fixture.close(done));
    await rm(home, { recursive: true, force: true });
  }
}

main().catch((error) => {
  if (process.env.HSTACK_QBO_FIXTURE_DEBUG === 'true') console.error(error);
  console.error(`QuickBooks synthetic runtime verification failed: ${error instanceof assert.AssertionError ? error.message : 'check the pinned runtime build and local fixture prerequisites'}`);
  process.exitCode = 1;
});
