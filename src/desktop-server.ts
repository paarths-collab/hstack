import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createSocialGateway } from './gateway.js';
import { DesktopProviders } from './desktop-session.js';

// A separate entry point intentionally excludes .env, configured connections and writes.
const providers = new DesktopProviders(process.env);
const handle = serveStdio(() => createSocialGateway([], {
  toolMode: 'search', readOnly: true, unavailableStatus: () => providers.status(), refresh: () => providers.refresh(),
}), { onerror: () => { console.error('Hstack Desktop MCP request failed.'); } });
let stopping: Promise<void> | undefined;
const stop = () => stopping ??= (async () => {
  try { await handle.close(); } finally { await providers.close(); }
})();
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
process.stdin.once('end', () => { void stop(); });
