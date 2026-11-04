// Test-only preload. No sockets, child processes, real credentials or accounts.
// Both Google's token and MCP URLs are handled entirely in memory.
import { readFileSync, appendFileSync } from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const file = process.env.HSTACK_BIGQUERY_FIXTURE_FILE;
if (!file) throw new Error('Synthetic BigQuery fixture is required.');
const fixture = JSON.parse(readFileSync(file, 'utf8'));
const record = event => appendFileSync(fixture.events, JSON.stringify({ event }) + '\n');
const blocked = () => { record('blocked'); throw new Error('Non-fixture network or process refused.'); };
net.Socket.prototype.connect = blocked;
for (const module of [http, https]) for (const name of ['request','get']) module[name] = blocked;
for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) childProcess[name] = blocked;
globalThis.fetch = async (url, init) => {
  if (init?.method !== 'POST' || init.redirect !== 'error' || init.credentials !== 'omit') return blocked();
  init.signal?.throwIfAborted();
  if (String(url) === 'https://oauth2.googleapis.com/token') {
    const form = new URLSearchParams(String(init.body));
    if (form.get('grant_type') !== 'refresh_token' || form.get('refresh_token') !== 'synthetic-refresh-value') return blocked();
    record('refresh'); return Response.json({ access_token: 'synthetic-access-value', expires_in: 3600, token_type: 'Bearer' });
  }
  if (String(url) !== 'https://bigquery.googleapis.com/mcp') return blocked();
  const request = JSON.parse(String(init.body)); const headers = new Headers(init.headers);
  if (request.method === 'initialize') {
    record('initialize'); return Response.json({ jsonrpc: '2.0', id: request.id, result: {
      protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'synthetic-bigquery', version: '0' },
    } });
  }
  if (request.method === 'notifications/initialized') { record('initialized'); return new Response(null, { status: 204 }); }
  if (request.method === 'tools/list') {
    if (headers.has('authorization')) return blocked();
    record('discovery'); return Response.json({ jsonrpc: '2.0', id: request.id, result: { tools: fixture.tools } });
  }
  if (request.method === 'tools/call') {
    if (headers.get('authorization') !== 'Bearer synthetic-access-value') return blocked();
    if (request.params.name !== 'list_dataset_ids') { record('sql'); return blocked(); }
    if (request.params.arguments?.projectId !== 'fixture-project') return blocked();
    record('read'); const value = { datasets: [{ id: fixture.datasetId }] };
    return Response.json({ jsonrpc: '2.0', id: request.id, result: {
      content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value,
    } });
  }
  return blocked();
};
syncBuiltinESMExports();
