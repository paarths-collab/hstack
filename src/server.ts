import type { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import type { StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { PassThrough } from 'node:stream';
import { DiscoveryError } from './discover-tools.js';
import { createSocialGateway } from './gateway.js';
import { loadSocialPackage } from './providers.js';
import type { LoadedProvider } from './providers.js';
import { loadConfiguredConnections } from './connections.js';
import { fileURLToPath } from 'node:url';
import { resolveSocialEnvironment } from './desktop-credentials.js';

// stdout is exclusively MCP protocol output. Buffer input during discovery so
// EOF can cancel startup without consuming/dropping the client's initialization.
const input = new PassThrough();
const shutdown = new AbortController();
const providers: LoadedProvider[] = [];
const owned = new Set<LoadedProvider>();
let server: Server | undefined;
let handle: StdioServerHandle | undefined;
let stopping: Promise<void> | undefined;
const closeOwned = async () => { await Promise.allSettled([...owned].map((provider) => provider.close?.())); };
const stop = (): Promise<void> => {
  if (stopping) return stopping;
  shutdown.abort();
  stopping = Promise.resolve().then(async () => {
    process.stdin.unpipe(input); process.stdin.pause(); input.destroy();
    try { if (handle) await handle.close(); else await server?.close(); } catch { /* No raw close errors in agent logs. */ }
    finally { await closeOwned(); }
  });
  return stopping;
};
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
process.stdin.once('end', () => { void stop(); });
process.stdin.once('error', () => { void stop(); });
process.stdout.once('error', () => { void stop(); });
process.stdin.pipe(input);

try {
  // Each invalid optional credential is isolated from other services.
  const desktop = await resolveSocialEnvironment(process.env);
  for (const id of desktop.failed) console.error(`Hstack: saved Desktop ${id} credential is unavailable; other connections remain usable.`);
  const socialEnv = desktop.env;
  const [social, configured] = await Promise.all([
    loadSocialPackage(socialEnv, undefined, shutdown.signal),
    loadConfiguredConnections(process.env.HSTACK_CONNECTIONS_FILE ?? fileURLToPath(new URL('../connections.json', import.meta.url)), process.env, undefined, shutdown.signal)
      .catch((error) => {
        if (!shutdown.signal.aborted) console.error(error instanceof DiscoveryError ? error.message : 'Connection configuration failed.');
        return { providers: [], failed: [] };
      }),
  ]);
  for (const provider of [...social.providers, ...configured.providers]) owned.add(provider);
  if (shutdown.signal.aborted) throw new DiscoveryError('Startup cancelled.', { code: 'CANCELLED' });
  providers.push(...social.providers);
  const failed = [...social.failed, ...configured.failed];
  const ids = new Set(providers.map((provider) => provider.id));
  for (const provider of configured.providers) {
    if (ids.has(provider.id)) {
      await provider.close?.();
      owned.delete(provider);
      failed.push(provider.id);
    } else { providers.push(provider); ids.add(provider.id); }
  }
  for (const id of failed) console.error(`Hstack: ${id} failed to connect; its tools are unavailable. Other connections remain usable.`);
  if (providers.length === 0) {
    throw new DiscoveryError('No provider connected. Configure a social key or a connection in connections.json; use Hstack check/login to diagnose setup.');
  }
  if (shutdown.signal.aborted) throw new DiscoveryError('Startup cancelled.', { code: 'CANCELLED' });
  handle = serveStdio(() => {
    server = createSocialGateway(providers, {
      toolMode: process.env.HSTACK_TOOL_MODE === 'search' ? 'search' : 'forward', failed,
    });
    server.onclose = () => { void stop(); };
    return server;
  }, { transport: new StdioServerTransport(input), onerror: () => {
    console.error('Hstack MCP protocol error; raw diagnostics are hidden.');
    process.exitCode = 1; void stop();
  } });
} catch (error) {
  if (!shutdown.signal.aborted) {
    console.error(error instanceof DiscoveryError ? error.message : 'Hstack could not start its MCP transport.');
    process.exitCode = 1;
  }
  await stop();
  // Providers may have finished discovery after the first signal handler ran.
  await closeOwned();
}
