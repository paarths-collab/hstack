import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { readFile, mkdir, lstat, mkdtemp, open, rm } from 'node:fs/promises';
import { parseConnections, type Connection } from './connections.js';
import { DiscoveryError } from './errors.js';

interface Selection {
  id: string;
  action: 'add-disabled' | 'replace-unused-placeholder' | 'preserve-configured';
  changedKeys: string[];
  bundledProfile: Connection;
  evidence: string;
  docs: string;
}
export interface PreparationPlan {
  version: 1;
  sourceSha256: string | null;
  selections: Selection[];
  activation: 'manual';
  note: string;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const usage = () => new DiscoveryError('Select distinct bundled service IDs. See docs/connections.md; no configuration was changed.');

async function bundled() {
  const profiles = parseConnections(JSON.parse(await readFile(new URL('../connections.example.json',import.meta.url),'utf8')));
  const catalogue = JSON.parse(await readFile(new URL('../catalog/services.json',import.meta.url),'utf8')) as Array<{id:string;name:string;docs:string;evidence:string;url:string|null}>;
  return {profiles,catalogue};
}

/** Candidate availability is not account validation or production readiness. */
export async function setupCatalogue() {
  const {profiles,catalogue} = await bundled();
  return catalogue.map((entry) => ({id:entry.id,canPrepare:profiles.some((profile) => profile.id === entry.id && profile.command !== '/absolute/path/to/configured-vendor-mcp'),evidence:entry.evidence,docs:entry.docs}));
}

function unusedPlaceholder(config: Connection, names: string[], vendorUrl?: string): boolean {
  const keys = new Set(['id','label','enabled','transport','command','args','env','readTools','allowWrites']);
  return !config.enabled && !config.allowWrites && config.transport === 'stdio'
    && names.includes(config.label)
    && ((config.command === '/absolute/path/to/configured-vendor-mcp' && (config.args?.length ?? 0) === 0)
      || (vendorUrl !== undefined && config.command === 'mcp-remote' && config.args?.length === 1 && config.args[0] === vendorUrl))
    && Object.keys(config.env ?? {}).length === 0
    && config.readTools.length === 0 && Object.keys(config).every((key) => keys.has(key));
}

/** Private merged contents never leave this module except as an owner-only file. */
async function build(configPath: string, ids: string[]) {
  if (!ids.length || ids.length > 30 || new Set(ids).size !== ids.length || ids.some((id) => !/^[a-z][a-z0-9-]*$/.test(id))) throw usage();
  const {profiles:templates,catalogue} = await bundled();
  const chosen = ids.map((id) => {
    const profile = templates.find((item) => item.id === id);
    const entry = catalogue.find((item) => item.id === id);
    if (!profile || !entry) throw usage();
    if (profile.command === '/absolute/path/to/configured-vendor-mcp') {
      throw new DiscoveryError(`${id}: vendor setup is unresolved; no candidate was created. Follow its catalogue instructions before configuring a connection.`);
    }
    if (profile.enabled || profile.allowWrites || profile.writeTools?.length) throw new DiscoveryError('Bundled setup profiles must start disabled with no write opt-in.');
    return { profile, entry };
  });
  let original: string | undefined;
  try { original = await readFile(configPath,'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new DiscoveryError('Cannot read the selected configuration. It was not changed.'); }
  let document: Record<string,unknown>;
  let configs: Connection[];
  try {
    if (original !== undefined && Buffer.byteLength(original) > 1_000_000) throw new Error('Size');
    document = original === undefined ? { connections:[] } : JSON.parse(original);
    configs = parseConnections(document);
  } catch { throw new DiscoveryError('Cannot prepare from invalid or oversized configuration. Review it privately; the original was preserved.'); }
  // Retain all original top-level and per-connection values. Only a narrowly
  // recognized unused placeholder may be replaced by a disabled public template.
  const next = [...configs];
  const selections: Selection[] = [];
  for (const {profile,entry} of chosen) {
    const index = next.findIndex((item) => item.id === profile.id);
    const current = next[index];
    const action = !current ? 'add-disabled'
      : unusedPlaceholder(current,[entry.name,profile.label],profile.transport === 'http' ? entry.url ?? undefined : undefined) ? 'replace-unused-placeholder' : 'preserve-configured';
    let changedKeys: string[] = [];
    if (action !== 'preserve-configured') {
      changedKeys = [...new Set([...Object.keys(current ?? {}),...Object.keys(profile)])]
        .filter((key) => JSON.stringify((current as unknown as Record<string,unknown> | undefined)?.[key]) !== JSON.stringify((profile as unknown as Record<string,unknown>)[key])).sort();
      if (index < 0) next.push(profile); else next[index] = profile;
    }
    selections.push({ id:profile.id,action,changedKeys,bundledProfile:profile,evidence:entry.evidence,docs:entry.docs });
  }
  const plan: PreparationPlan = { version:1,sourceSha256:original === undefined ? null : digest(original),selections,activation:'manual',
    note:'Public bundled defaults only. Configured values are never printed. New or replaced profiles are disabled. Existing settings are preserved. No install, login, network request or tool execution has run.' };
  return { plan, contents:JSON.stringify({ ...document,connections:next },null,2)+'\n' };
}

/** Read-only review: returns public templates and change names, never private values. */
export async function planConnections(configPath: string, ids: string[]): Promise<PreparationPlan> {
  return (await build(configPath,ids)).plan;
}

/** Creates a new private snapshot; never edits or activates the source file. */
export async function prepareConnections(configPath: string, ids: string[]): Promise<{plan:PreparationPlan;candidatePath:string}> {
  const {plan,contents} = await build(configPath,ids);
  if (process.platform === 'win32' || !process.getuid) throw new DiscoveryError('Private candidate creation currently requires POSIX owner permissions. Review the plan and configure manually on this platform.');
  const root = join(dirname(resolve(configPath)),'.hstack-setup');
  let folder: string | undefined;
  try {
    try { await mkdir(root,{mode:0o700}); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
      throw new DiscoveryError('The setup snapshot directory is unsafe. Use a private owner-only directory; existing files were preserved.');
    }
    folder = await mkdtemp(join(root,'candidate-'));
    const write = async (name: string, data: string) => {
      const handle = await open(join(folder!,name),'wx',0o600);
      try { await handle.writeFile(data,'utf8'); await handle.sync(); } finally { await handle.close(); }
    };
    await write('connections.json',contents);
    await write('plan.json',JSON.stringify(plan,null,2)+'\n');
    return { plan,candidatePath:join(folder,'connections.json') };
  } catch (error) {
    if (folder) await rm(folder,{recursive:true,force:true}).catch(() => {});
    if (error instanceof DiscoveryError) throw error;
    throw new DiscoveryError('Could not create a private setup candidate. Existing configuration and snapshots were preserved.');
  }
}
