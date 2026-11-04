import { access, constants, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { parseConnections, resolveConnection, type Connection } from './connections.js';
import { vendorEnvironmentIssues } from './vendor-contracts.js';

export interface SetupReport { issues: string[]; notes: string[] }

async function executableExists(command: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  // Match spawn's no-shell lookup. Never execute a program to inspect it.
  const paths = isAbsolute(command) || command.includes('/') || command.includes('\\')
    ? [command] : (env.PATH ?? (process.platform === 'win32' ? '' : '/usr/bin:/bin')).split(delimiter)
      .map((directory) => join(directory || '.', command));
  for (const path of paths) {
    try { await access(path, constants.X_OK); if ((await stat(path)).isFile()) return true; } catch { /* try the next PATH entry */ }
  }
  return false;
}

/** Offline only: no spawning, credential-store reads, login, network or configuration writes. */
export async function checkSetup(config: Connection, env: NodeJS.ProcessEnv): Promise<SetupReport> {
  parseConnections({ connections: [config] });
  const issues: string[] = [];
  const notes: string[] = [];
  const names = new Set([
    config.urlEnv, config.commandEnv, config.oauth?.clientSecretEnv, config.googleBigQuery?.credentialsFileEnv,
    config.oauth?.issuerEnv, config.oauth?.clientIdEnv, config.oauth?.scopeEnv, config.oauth?.clientMetadataUrlEnv,
    ...(config.transport === 'http' ? Object.values(config.headers ?? {}).map((ref) => ref.env) : []),
    ...(config.transport === 'stdio' ? Object.values(config.env ?? {}) : []),
  ].filter((name): name is string => !!name));
  for (const name of names) if (!env[name]?.trim()) issues.push(`Set ${name} in the launch environment.`);
  if (config.transport === 'stdio') issues.push(...vendorEnvironmentIssues(config.resultPolicy,
    Object.fromEntries(Object.entries(config.env ?? {}).map(([name, ref]) => [name, env[ref] ?? '']))));
  const canResolve = [config.urlEnv, config.commandEnv, config.oauth?.issuerEnv, config.oauth?.clientIdEnv,
    config.oauth?.scopeEnv, config.oauth?.clientMetadataUrlEnv].every((name) => !name || !!env[name]?.trim());
  if (canResolve) {
    let resolved: Connection | undefined;
    try { resolved = resolveConnection(config, env); }
    catch { issues.push('The configured endpoint or OAuth settings are invalid; review them privately.'); }
    if (resolved?.transport === 'stdio') {
      if (/absolute\/path|configured-vendor-mcp|insert-your/i.test(resolved.command!)) {
        issues.push('Replace the placeholder command with a reviewed installed vendor executable.');
      } else if (!await executableExists(resolved.command!, env)) {
        issues.push('Configured executable is missing or not executable in the launch environment.');
      }
      notes.push('Executable presence does not verify its version, arguments, dependencies or vendor login.');
    }
  }
  notes.push(config.enabled ? 'Enabled for the next Hstack startup.' : 'Disabled; Hstack will not load it at startup.');
  if (config.oauth) notes.push(`OAuth login, scopes and refresh have not been checked. Use login ${config.id}, then check ${config.id}.`);
  if (config.googleBigQuery) notes.push('BigQuery uses the official SDK legacy handshake; discovery is public and does not verify credentials. Uses an explicit private Google credential file; real project/IAM access remains unverified. SQL tools can incur charges and require deliberate permission review.');
  if (config.id === 'snowflake') notes.push('Snowflake is an unverified native HTTP candidate. Vendor documentation excludes lifecycle/version negotiation; SDK initialization must be validated against your account before activation. Registered OAuth, exact loopback callback approval, a default warehouse and per-tool grants are required. Search, SQL, agents and custom tools can incur charges or mutate data; review actual tool definitions and server privileges before permitting any operation.');
  if (config.oauth?.clientId !== undefined || config.oauth?.clientIdEnv !== undefined) {
    notes.push('Uses a pre-registered OAuth client; register the exact callback and permitted scopes with the vendor first.');
  }
  if (config.oauth?.clientMetadataUrl !== undefined || config.oauth?.clientMetadataUrlEnv !== undefined) {
    notes.push('Uses a Client ID Metadata Document: publish the public JSON at the exact HTTPS client ID URL with the exact loopback callback and no client secret. Offline checks do not fetch or validate that document.');
  }
  if (config.oauth?.dcrAuthMethod) notes.push(`Dynamic registration explicitly requests ${config.oauth.dcrAuthMethod}. Vendor metadata must advertise it and registration must return the matching method and a secret; no automatic method switch is made. The generated client secret is saved in the private plaintext OAuth store. Real registration/account acceptance remains unverified.`);
  notes.push(config.allowWrites
    ? 'allowWrites is true: all discovered operations can be called. Review this before enabling.'
    : config.writeTools?.length ? `${config.readTools.length} explicit reads and ${config.writeTools.length} explicit write/unreviewed tools allowed; all others blocked.`
    : config.readTools.length ? `${config.readTools.length} explicit read tools allowed; all others blocked.`
      : 'readTools is empty: every operation will be blocked until reviewed. Discovery and account access remain unverified by this offline check.');
  notes.push('Offline check only. No service contacted, credential validated, tool executed or file changed.');
  return { issues, notes };
}
