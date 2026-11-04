// Test-only preload: native Intuit HTTP clients may reach ONLY the synthetic
// loopback fixture. Not used by installed profiles or normal authentication.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import childProcess from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const port = Number(process.env.HSTACK_QBO_FIXTURE_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Synthetic fixture port required.');
const blocked = () => {
  appendFileSync(process.env.HSTACK_QBO_FIXTURE_EVENTS, 'blocked\n');
  throw new Error('Non-fixture network or browser process refused.');
};
const request = http.request;
https.request = (...args) => {
  let options, callback;
  if (typeof args[0] === 'string' || args[0] instanceof URL) {
    const url = new URL(args[0]);
    options = { hostname: url.hostname, path: url.pathname + url.search, ...(typeof args[1] === 'object' ? args[1] : {}) };
    callback = typeof args[1] === 'function' ? args[1] : args[2];
  } else { options = { ...args[0] }; callback = args[1]; }
  const hostname = options.hostname ?? options.host;
  if (!['oauth.platform.intuit.com', 'sandbox-quickbooks.api.intuit.com', 'quickbooks.api.intuit.com'].includes(hostname)) return blocked();
  return request({ ...options, protocol: 'http:', hostname: '127.0.0.1', host: '127.0.0.1', port,
    agent: false, headers: { ...options.headers, 'x-hstack-fixture-origin': hostname } }, callback);
};
https.get = (...args) => { const req = https.request(...args); req.end(); return req; };
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const target = typeof first === 'object' ? first : { port: first, host: typeof args[1] === 'string' ? args[1] : undefined };
  if (target?.host !== '127.0.0.1' || Number(target.port) !== port) return blocked();
  return Reflect.apply(connect, this, args);
};
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[name] = blocked;
globalThis.fetch = blocked;
syncBuiltinESMExports();
