// Shared helpers for the acceptance JS tests (Agent B). Everything here is offline:
// a throwaway HOME, the bash test double tests/acceptance/stubs/hermes, fake secrets assembled at
// runtime (no token-shaped literals in the repository), and a test-side delivery observer that reads
// the stub's outbox (a TEST DOUBLE of Telegram, not evidence about real Telegram).
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadContract } from "../../../packages/acceptance/contract.js";
import { validateReceipt } from "../../../packages/acceptance/receipt.js";
import { SandboxTransport } from "../../../packages/acceptance/transports.js";
import { DEFAULT_SCRIPT_PATH, Transaction } from "../../../packages/acceptance/transaction.js";
import { compileFounderBrief } from "../../../packages/recipe-core/index.js";
import { freshStubDeliveries } from "./stub-observer.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, "..", "..", "..");
export const STUB = path.join(REPO, "tests", "acceptance", "stubs", "hermes");
export const FIXTURE_SKILLS = path.join(REPO, "tests", "acceptance", "fixtures", "skills");
export const SCRIPT_PRESENT = existsSync(DEFAULT_SCRIPT_PATH);
export const SCRIPT_SKIP = SCRIPT_PRESENT ? false : "skipped: packages/acceptance/target/hstack-target.sh is not present (Agent A deliverable); integration tests cannot run";

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
export const fingerprint = (chatId) => sha256(`telegram:${chatId}`).slice(0, 16);

// Fake secrets, assembled at runtime. None is a real credential.
export const FAKE = {
  github: ["g", "hp_", "FAKEFAKEFAKEFAKEFAKEFAKEFAKE0001"].join(""),
  bot: ["123456", `FAKE${"x".repeat(34)}`].join(":"),
  botOld: ["654321", `OLDFAKE${"y".repeat(31)}`].join(":"),
  allowed: "111222333",
  chat: "555000111",
  otherChat: "777000999",
  vulnerableLeak: ["SYNTHETIC", "LEAK", "d41d8cd98f00b204e9800998ecf8427e"].join("-"),
};
export const SCHEDULE = "0 8 * * 1-5";
export const OPERATOR = Object.freeze({ chatId: FAKE.chat, schedule: SCHEDULE });
export const SECRET_VALUES = Object.freeze({
  GITHUB_TOKEN: FAKE.github,
  TELEGRAM_BOT_TOKEN: FAKE.bot,
  TELEGRAM_ALLOWED_USERS: FAKE.allowed,
});
export const ALL_SECRET_STRINGS = [FAKE.github, FAKE.bot, FAKE.botOld, FAKE.chat, FAKE.otherChat, FAKE.vulnerableLeak];

export const contract = loadContract();

// ---- blueprint from the real compiler --------------------------------------------------------

function collectJson(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectJson(full);
    return entry.name.endsWith(".json") ? [full] : [];
  });
}
const recipe = JSON.parse(readFileSync(path.join(REPO, "recipes", "founder-brief", "recipe.json"), "utf8"));
const connectors = collectJson(path.join(REPO, "connectors")).map((file) => JSON.parse(readFileSync(file, "utf8")));

/** The plan for github -> telegram, compiled by recipe-core exactly as the contract's plan_source says. */
export function makeBlueprint({ cadence = "weekdays" } = {}) {
  const result = compileFounderBrief({
    recipe, connectors,
    selection: { sourceIds: contract.plan_source.source_ids, deliveryIds: contract.plan_source.delivery_ids, cadence },
  });
  if (!result.deployable) throw new Error("fixture blueprint is not deployable");
  return structuredClone(result.blueprint);
}

// ---- file helpers ------------------------------------------------------------------------------

export function scratchDir(prefix = "hstack-acc-") {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Deterministic hash of a tree: names, types, modes, bytes, symlink targets. No mtimes. */
export function treeHash(root, exclude = []) {
  const lines = [];
  const skip = (rel) => exclude.some((x) => rel === x || rel.startsWith(`${x}/`));
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const rel = path.relative(root, full);
      if (skip(rel)) continue;
      const st = lstatSync(full);
      const mode = (st.mode & 0o7777).toString(8);
      if (st.isSymbolicLink()) lines.push(`${rel}|L|${readlinkSync(full)}`);
      else if (st.isDirectory()) { lines.push(`${rel}|D|${mode}`); walk(full); }
      else lines.push(`${rel}|F|${mode}|${sha256(readFileSync(full))}`);
    }
  };
  if (existsSync(root)) walk(root);
  return sha256(lines.join("\n"));
}

/** Relative paths of every file under root whose bytes contain `needle`. */
export function filesContaining(root, needle) {
  const hits = [];
  const buf = Buffer.from(needle);
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(full);
      else if (readFileSync(full).includes(buf)) hits.push(path.relative(root, full));
    }
  };
  if (existsSync(root)) walk(root);
  return hits.sort();
}

// ---- the sandbox target ------------------------------------------------------------------------

export class Target {
  constructor({ hermes = true, seed = true } = {}) {
    this.root = scratchDir("hstack-acc-target-");
    this.home = path.join(this.root, "home");
    this.stubLog = path.join(this.root, "stub.log"); // outside HOME: logging never perturbs tree hashes
    this.githubFixture = path.join(this.root, "github-fixture.txt");
    this.receipts = path.join(this.root, "receipts");
    mkdirSync(path.join(this.home, ".local", "bin"), { recursive: true });
    if (hermes) symlinkSync(STUB, path.join(this.home, ".local", "bin", "hermes"));
    this.hermesDir = path.join(this.home, ".hermes");
    this.envPath = path.join(this.hermesDir, ".env");
    this.cronPath = path.join(this.hermesDir, "cron.db");
    this.outboxPath = path.join(this.hermesDir, "outbox.log");
    this.gatewayPath = path.join(this.hermesDir, "gateway.state");
    this.skillsPath = path.join(this.hermesDir, "skills");
    this.statePath = path.join(this.hermesDir, ".hstack");
    if (seed) this.seed();
  }

  /** Pre-existing user state that the transaction must never touch. */
  seed({ priorBot = null } = {}) {
    mkdirSync(path.join(this.skillsPath, "my-own-skill"), { recursive: true });
    writeFileSync(path.join(this.skillsPath, "my-own-skill", "SKILL.md"), "# my own skill\nuser content\n");
    const env = ["UNRELATED_SETTING=keep-me", "ANOTHER_KEY=also-keep", ...(priorBot ? [`TELEGRAM_BOT_TOKEN=${priorBot}`] : [])];
    writeFileSync(this.envPath, `${env.join("\n")}\n`, { mode: 0o600 });
    writeFileSync(path.join(this.hermesDir, "config.yaml"), "model: example\nlogging: info\n", { mode: 0o600 });
    writeFileSync(this.cronPath, "job-0\t30 2 * * *\tunrelated nightly job\n", { mode: 0o600 });
    writeFileSync(path.join(this.hermesDir, "cron.seq"), "0\n", { mode: 0o600 });
  }

  cleanup() { rmSync(this.root, { recursive: true, force: true }); }

  /** Hash of everything the target owns (HOME), excluding nothing: used for "zero writes" proofs. */
  homeHash() { return treeHash(this.home); }
  env() { return existsSync(this.envPath) ? readFileSync(this.envPath, "utf8") : ""; }
  cron() { return existsSync(this.cronPath) ? readFileSync(this.cronPath, "utf8") : ""; }
  managedCronLines() { return this.cron().split("\n").filter((line) => line.includes("[hstack:founder-brief]")); }
  stubCalls() {
    if (!existsSync(this.stubLog)) return [];
    return readFileSync(this.stubLog, "utf8").split("\n").filter(Boolean).map((line) => line.split("\t"));
  }

  transport({ env = {} } = {}) {
    return new SandboxTransport({
      home: this.home,
      extraEnv: {
        HSTACK_STUB_LOG: this.stubLog,
        HSTACK_RELOAD_DELAY: "0",
        HSTACK_STUB_GITHUB_FIXTURE: this.githubFixture,
        ...env,
      },
    });
  }

  setFixture(text) { writeFileSync(this.githubFixture, text); }

  /** Test-side observer: requires a successful dispatch and fresh, run-correlated stub output. */
  observer({ env = {}, secret = FAKE.vulnerableLeak } = {}) {
    const transport = this.transport({ env });
    const run = (remote) => transport.exec({ op: "observer", remote, stdin: null, redactedStdin: null, mutates: "none" });
    return {
      delivery: async () => {
        const list = await run('export PATH="$HOME/.local/bin:$PATH"; hermes cron list');
        if (list.code !== 0 || list.transportError) return { deliveries: [] };
        const entries = list.stdout.split("\n").filter((line) => line.includes("[hstack:founder-brief]"));
        if (entries.length !== 1) return { deliveries: [] };
        const jobId = entries[0].split("\t")[0];
        if (!/^[A-Za-z0-9-]+$/.test(jobId)) return { deliveries: [] };
        const before = existsSync(this.outboxPath) ? readFileSync(this.outboxPath, "utf8") : "";
        const runId = randomBytes(16).toString("hex");
        const dispatched = await run(`export PATH="$HOME/.local/bin:$PATH"; HSTACK_STUB_RUN_ID=${runId} hermes cron run ${jobId}`);
        if (dispatched.code !== 0 || dispatched.transportError) return { deliveries: [] };
        const after = existsSync(this.outboxPath) ? readFileSync(this.outboxPath, "utf8") : "";
        return { deliveries: freshStubDeliveries(before, after, runId, [secret, FAKE.github, FAKE.bot, FAKE.botOld]) };
      },
    };
  }
}

/** Deterministic clock: each call advances one second from a fixed instant. */
export function fixedClock(start = "2026-01-01T00:00:00.000Z") {
  let t = Date.parse(start);
  return () => {
    const value = new Date(t).toISOString();
    t += 1000;
    return value;
  };
}

export function newTransaction(target, overrides = {}) {
  return new Transaction({
    blueprint: makeBlueprint(),
    contract,
    operator: OPERATOR,
    transport: target.transport(),
    receiptDir: target.receipts,
    skillsRoot: FIXTURE_SKILLS,
    allowNonLinuxTarget: true, // the sandbox may run on macOS; recorded as `skipped` in the receipt
    ...overrides,
  });
}

/** Drive validate -> inspect -> review -> stage -> apply (stops before verify). Returns the transaction. */
export async function driveToApplied(target, overrides = {}, values = SECRET_VALUES) {
  const tx = newTransaction(target, overrides);
  const validated = await tx.validate();
  if (!validated.ok) throw new Error(`validate failed: ${JSON.stringify(validated)}`);
  const inspected = await tx.inspect();
  if (!inspected.ok) throw new Error(`inspect blocked: ${inspected.blocked_reason}`);
  await tx.reviewChanges((review) => review.plan_hash);
  const staged = await tx.stage(values);
  if (!staged.ok) throw new Error(`stage blocked: ${staged.blocked_reason}`);
  const applied = await tx.apply();
  return { tx, applied };
}

/** Every file and directory below root (not root itself), depth-first. Works on Node 18. */
export function listTree(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const dirEntry = lstatSync(full).isDirectory();
      out.push({ full, dir: dirEntry });
      if (dirEntry) walk(full);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

/** Every string in a value, deeply, for secret scanning. */
export function allStrings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => allStrings(v, out));
  else if (value && typeof value === "object") Object.entries(value).forEach(([k, v]) => { out.push(k); allStrings(v, out); });
  return out;
}

export function readAllReceiptText(receiptsRoot) {
  const chunks = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (lstatSync(full).isDirectory()) walk(full);
      else chunks.push(readFileSync(full, "utf8"));
    }
  };
  if (existsSync(receiptsRoot)) walk(receiptsRoot);
  return chunks.join("\n");
}

// ---- assertions shared by the integration tests ---------------------------------------------


/** Everything the target owns that a transaction must leave alone or restore (hstack's own state dir excluded). */
export function userStateHash(target) {
  return treeHash(target.hermesDir, [".hstack", "cron.seq", "gateway.state", "outbox.log"]);
}

/** A receipt must validate and must contain none of the synthetic secrets (also in every file under the receipt dir). */
export function assertReceiptClean(assert, target, tx) {
  const receipt = tx.receipt;
  const result = validateReceipt(receipt, { requiredChecks: contract.required_checks });
  assert.deepEqual(result.errors, [], "receipt must validate");
  const text = readAllReceiptText(target.receipts);
  for (const secret of ALL_SECRET_STRINGS) assert.equal(text.includes(secret), false, "a synthetic secret leaked into a receipt or evidence file");
  return receipt;
}

/** Transport that runs ops for real but lies about the outcome of ops named in `lose` (unknown outcome). */
export function losingTransport(inner, lose) {
  return {
    kind: inner.kind,
    exec: async (op) => {
      const result = await inner.exec(op);
      return lose.includes(op.op) ? { ...result, transportError: true } : result;
    },
  };
}
