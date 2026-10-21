// Shared helpers for the hstack-target.sh sandbox tests.
//
// Every test runs the REAL script (packages/acceptance/target/hstack-target.sh) with
//   env -i HOME=<sandbox>/home PATH=/usr/bin:/bin [knobs] bash <script> <op> ...
// against a throwaway HOME under os.tmpdir(). The `hermes` on the sandbox is the bash TEST DOUBLE
// tests/acceptance/stubs/hermes (a declared adapter surface, not real Hermes). Nothing here talks
// to a network, a model or a real secret store; all secrets are obviously fake and are assembled at
// runtime so the repository source contains no token-shaped literals.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '..', '..', '..', '..');
export const SCRIPT = process.env.HSTACK_TARGET_SCRIPT || join(REPO, 'packages', 'acceptance', 'target', 'hstack-target.sh');
export const STUB = join(REPO, 'tests', 'acceptance', 'stubs', 'hermes');
export const BASH = process.env.HSTACK_TEST_BASH || 'bash';

export const KEYS = ['GITHUB_TOKEN', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_USERS', 'TELEGRAM_HOME_CHANNEL'];
export const ALLOW = KEYS.join(',');
export const TXN = 'abcd1234efgh';
export const TXN2 = 'zzzz9999yyyy';

// Fake secrets, assembled at runtime. None is a real credential.
export const FAKE = {
  github: 'g' + 'hp_' + 'FAKEFAKEFAKEFAKEFAKEFAKEFAKE0001',
  bot: ['123456', 'FAKE' + 'x'.repeat(34)].join(':'),
  botOld: ['654321', 'OLDFAKE' + 'y'.repeat(31)].join(':'),
  allowed: '111222333',
  chat: '-1009998887776',
};

export function pinnedHermesVersion() {
  const m = /^HERMES_VERSION=(.+)$/m.exec(readFileSync(join(REPO, 'VERSIONS.txt'), 'utf8'));
  return m[1].trim();
}

export function parseKv(stdout) {
  const kv = {};
  for (const line of stdout.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
  }
  return kv;
}

export const sha256 = (b) => createHash('sha256').update(b).digest('hex');
export const fingerprint = (chat) => sha256('telegram:' + chat).slice(0, 16);

/** Deterministic hash of a directory tree: names, types, modes, bytes, symlink targets. No mtimes. */
export function treeHash(root, exclude = []) {
  const lines = [];
  const skip = (rel) => exclude.some((x) => rel === x || rel.startsWith(x + '/'));
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const rel = relative(root, p);
      if (skip(rel)) continue;
      const st = lstatSync(p);
      const mode = (st.mode & 0o7777).toString(8);
      if (st.isSymbolicLink()) lines.push(`${rel}|L|${readlinkSync(p)}`);
      else if (st.isDirectory()) { lines.push(`${rel}|D|${mode}`); walk(p); }
      else lines.push(`${rel}|F|${mode}|${sha256(readFileSync(p))}`);
    }
  };
  if (existsSync(root)) walk(root);
  return sha256(lines.join('\n'));
}

/** Every file under root (any depth) whose bytes contain `needle`; returns relative paths. */
export function filesContaining(root, needle) {
  const hits = [];
  const buf = Buffer.from(needle);
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p);
      else if (readFileSync(p).includes(buf)) hits.push(relative(root, p));
    }
  };
  walk(root);
  return hits.sort();
}

export const modeOf = (p) => (lstatSync(p).mode & 0o7777).toString(8);

/** Minimal ustar writer so hostile archives (../, absolute, symlink, hardlink) can be forged portably. */
export function ustar(entries) {
  const blocks = [];
  const oct = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';
  for (const e of entries) {
    const content = e.content === undefined ? Buffer.alloc(0) : Buffer.from(e.content);
    const type = e.type || (e.dir ? '5' : '0');
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 100, 'utf8');
    h.write(oct(type === '5' ? 0o755 : 0o644, 8), 100, 8, 'ascii');
    h.write(oct(0, 8), 108, 8, 'ascii');
    h.write(oct(0, 8), 116, 8, 'ascii');
    h.write(oct(type === '0' ? content.length : 0, 12), 124, 12, 'ascii');
    h.write(oct(1700000000, 12), 136, 12, 'ascii');
    h.write('        ', 148, 8, 'ascii');
    h.write(type, 156, 1, 'ascii');
    if (e.linkname) h.write(e.linkname, 157, 100, 'utf8');
    h.write('ustar\0', 257, 6, 'ascii');
    h.write('00', 263, 2, 'ascii');
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    blocks.push(h);
    if (type === '0' && content.length) {
      blocks.push(content);
      const pad = (512 - (content.length % 512)) % 512;
      if (pad) blocks.push(Buffer.alloc(pad));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** A well-formed skills archive: { name: { 'SKILL.md': 'text', 'sub/file': 'text' } }. */
export function skillTar(skills) {
  const entries = [];
  for (const [name, files] of Object.entries(skills)) {
    entries.push({ name: `${name}/`, dir: true });
    const dirs = new Set();
    for (const f of Object.keys(files)) {
      const parts = f.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(`${name}/${parts.slice(0, i).join('/')}/`);
    }
    for (const d of [...dirs].sort()) entries.push({ name: d, dir: true });
    for (const [f, c] of Object.entries(files)) entries.push({ name: `${name}/${f}`, content: c });
  }
  return ustar(entries);
}

export class Sandbox {
  constructor({ stub = true } = {}) {
    this.root = mkdtempSync(join(tmpdir(), 'hstack-sbx-'));
    this.home = join(this.root, 'home');
    this.log = join(this.root, 'stub.log'); // outside HOME so logging never perturbs tree hashes
    mkdirSync(join(this.home, '.local', 'bin'), { recursive: true });
    if (stub) symlinkSync(STUB, join(this.home, '.local', 'bin', 'hermes'));
    this.h = join(this.home, '.hermes');
    this.envPath = join(this.h, '.env');
    this.cfgPath = join(this.h, 'config.yaml');
    this.skillsPath = join(this.h, 'skills');
    this.cronPath = join(this.h, 'cron.db');
    this.statePath = join(this.h, '.hstack');
    this.manifestPath = join(this.statePath, 'managed-skills.tsv');
  }

  cleanup() { rmSync(this.root, { recursive: true, force: true }); }

  write(rel, data, mode) {
    const p = join(this.home, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, data);
    if (mode !== undefined) chmodSync(p, mode);
    return p;
  }

  read(rel) { return readFileSync(join(this.home, rel), 'utf8'); }
  exists(rel) { return existsSync(join(this.home, rel)); }
  env() { return readFileSync(this.envPath, 'utf8'); }
  cron() { return existsSync(this.cronPath) ? readFileSync(this.cronPath, 'utf8') : ''; }
  txnPath(txn = TXN) { return join(this.statePath, 'txn', txn); }
  hash(exclude = []) { return treeHash(this.root, ['stub.log', ...exclude]); }
  homeHash(exclude = []) { return treeHash(this.home, exclude); }

  stubCalls() {
    if (!existsSync(this.log)) return [];
    return readFileSync(this.log, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t'));
  }

  run(args, { input, env = {}, home, path = '/usr/bin:/bin' } = {}) {
    const r = spawnSync('env', [
      '-i', `HOME=${home || this.home}`, `PATH=${path}`, `HSTACK_STUB_LOG=${this.log}`,
      'HSTACK_RELOAD_DELAY=0',
      ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
      BASH, SCRIPT, ...args,
    ], { input: input === undefined ? '' : input, timeout: 60000 });
    const stdout = r.stdout.toString('utf8');
    const stderr = r.stderr.toString('utf8');
    return { status: r.status, stdout, stderr, kv: parseKv(stdout) };
  }

  // ---- transaction conveniences ----
  backup(txn = TXN, keys = ALLOW, extra = []) { return this.run(['backup', txn, '--keys', keys, ...extra]); }
  put(key, value, txn = TXN, allow = ALLOW) { return this.run(['put-env', txn, key, '--allow', allow], { input: value + '\n' }); }
  stageCheck(txn = TXN) { return this.run(['stage-check', txn]); }
  apply(txn = TXN, crons = []) { return this.run(['apply', txn, ...crons.flatMap((c) => ['--cron', c])]); }
  restore(txn = TXN, env) { return this.run(['restore', txn], { env }); }
  commit(txn = TXN) { return this.run(['commit', txn]); }
  syncSkills(tar, names, txn = TXN) { return this.run(['skills-sync', txn, '--names', names], { input: tar }); }
  verify(over = {}, txn = TXN) {
    const a = {
      fp: fingerprint(FAKE.chat), allowVar: 'TELEGRAM_ALLOWED_USERS', destVar: 'TELEGRAM_HOME_CHANNEL',
      cronId: 'founder-brief', schedule: '0 9 * * *', ...over,
    };
    const args = ['verify', txn, '--destination-fp', a.fp, '--allow-var', a.allowVar, '--dest-var', a.destVar,
      '--cron-id', a.cronId, '--schedule', a.schedule];
    if (a.skills) args.push('--skills', a.skills);
    return this.run(args);
  }

  /** backup + stage the four founder-brief keys (fake values). */
  stageAll(txn = TXN, values = {}) {
    const v = { GITHUB_TOKEN: FAKE.github, TELEGRAM_BOT_TOKEN: FAKE.bot, TELEGRAM_ALLOWED_USERS: FAKE.allowed,
      TELEGRAM_HOME_CHANNEL: FAKE.chat, ...values };
    const b = this.backup(txn);
    if (b.status !== 0) throw new Error('backup failed: ' + b.stdout);
    for (const k of KEYS) {
      const r = this.put(k, v[k], txn);
      if (r.status !== 0) throw new Error(`put-env ${k} failed: ${r.stdout}`);
    }
    const s = this.stageCheck(txn);
    if (s.status !== 0) throw new Error('stage-check failed: ' + s.stdout);
    return v;
  }
}

export const CRON_SPEC = 'founder-brief|0 9 * * *|Send the founder brief of the last 24h of read-only GitHub activity';

export function sandbox(opts) { return new Sandbox(opts); }
