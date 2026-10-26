import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CANDIDATE_CONTRACT_PATH, ContractInvalid, DEFAULT_CONTRACT_PATH, DEFAULT_VERSIONS_PATH, KNOWN_ADAPTER_SURFACE, NATIVE_ADAPTER_SURFACE, contractHash, loadContract,
  parseVersions, readVersions, runtimeVersionSupported, validateContract,
} from "../../packages/acceptance/contract.js";
import { REPO, contract } from "./helpers/harness.mjs";

const raw = () => JSON.parse(readFileSync(DEFAULT_CONTRACT_PATH, "utf8"));
const readRepo = (...parts) => readFileSync(path.join(REPO, ...parts), "utf8");

function withContract(mutate, versionsFile) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hstack-contract-"));
  try {
    const value = raw();
    mutate(value);
    const file = path.join(dir, "c.json");
    writeFileSync(file, JSON.stringify(value));
    return () => loadContract(file, versionsFile === undefined ? {} : { versionsFile });
  } finally {
    // the closure reads lazily, so keep the file until it has been used
    setImmediate(() => rmSync(dir, { recursive: true, force: true }));
  }
}

test("the shipped (legacy fixture) contract declares the legacy fixture version read from VERSIONS.txt, and the two agree", () => {
  const fromFile = /^HERMES_LEGACY_FIXTURE_VERSION=(.+)$/m.exec(readRepo("VERSIONS.txt"))[1].trim();
  assert.equal(contract.runtime.declared_version, fromFile);
  assert.equal(contract.runtime.versions_source, "VERSIONS.txt#HERMES_LEGACY_FIXTURE_VERSION");
  assert.deepEqual(contract.runtime.supported_versions, [fromFile]);
  assert.equal(readVersions(DEFAULT_VERSIONS_PATH).HERMES_LEGACY_FIXTURE_VERSION, fromFile);
  const pkg = /^GITHUB_MCP_PKG=(.+)$/m.exec(readRepo("VERSIONS.txt"))[1].trim();
  assert.equal(contract.adapters.github.mcp_pkg, pkg);
  assert.equal(runtimeVersionSupported(contract, fromFile), true);
  assert.equal(runtimeVersionSupported(contract, "0.15.3"), false);
  assert.equal(runtimeVersionSupported(contract, "unknown"), false);
});

test("VERSIONS.txt pins the Hermes the skills target, its immutable installer, and a separate legacy fixture version", () => {
  const v = readVersions();
  assert.equal(v.HERMES_VERSION, "0.22.5");
  assert.match(v.HERMES_COMMIT, /^[0-9a-f]{40}$/);
  assert.equal(v.HERMES_INSTALLER_URL, `https://raw.githubusercontent.com/NousResearch/hermes-agent/${v.HERMES_COMMIT}/scripts/install.sh`);
  assert.match(v.HERMES_INSTALLER_SHA256, /^[0-9a-f]{64}$/);
  assert.equal(v.HERMES_LEGACY_FIXTURE_VERSION, "0.15.2");
  for (const removed of ["HERMES_CANDIDATE_VERSION", "HERMES_CANDIDATE_COMMIT", "HERMES_CANDIDATE_INSTALLER_URL", "HERMES_CANDIDATE_INSTALLER_SHA256"]) {
    assert.equal(Object.hasOwn(v, removed), false, removed);
  }
  assert.doesNotMatch(v.HERMES_INSTALLER_URL, /\/main\//, "the installer URL must be commit-addressed, not a mutable branch");
});

test("the native adapter's pinned version and commit are the VERSIONS.txt pins", () => {
  const adapter = readRepo("packages", "acceptance", "target", "native-hermes-v0_22_5.py");
  const v = readVersions();
  assert.equal(/^VERSION = "([^"]+)"/m.exec(adapter)?.[1], v.HERMES_VERSION);
  assert.equal(/^COMMIT = "([^"]+)"/m.exec(adapter)?.[1], v.HERMES_COMMIT);
});

test("loading enforces agreement with VERSIONS.txt: a drifted contract is rejected", () => {
  assert.throws(withContract((c) => { c.runtime.declared_version = "0.15.3"; c.runtime.supported_versions = ["0.15.3"]; }), (error) => {
    assert.ok(error instanceof ContractInvalid);
    assert.match(error.message, /disagrees with VERSIONS\.txt HERMES_LEGACY_FIXTURE_VERSION/);
    return true;
  });
  assert.throws(withContract((c) => { c.adapters.github.mcp_pkg = "@modelcontextprotocol/server-github@1999.01.01"; }), /GITHUB_MCP_PKG/);
  // The same drifted contract loads only when the caller opts out of the cross-check explicitly.
  const drifted = withContract((c) => { c.runtime.declared_version = "0.15.3"; c.runtime.supported_versions = ["0.15.3"]; }, null);
  assert.equal(drifted().runtime.declared_version, "0.15.3");
});

test("parseVersions ignores comments and blanks", () => {
  assert.deepEqual(parseVersions("# c\n\nA=1\n  B=two words \nbad line\n"), { A: "1", B: "two words" });
});

test("the Hermes 0.22.5 contract is explicit, source-verified only, and cannot be mixed with the legacy fixture", () => {
  const target = loadContract(CANDIDATE_CONTRACT_PATH);
  const versions = readVersions();
  assert.equal(target.runtime.declared_version, versions.HERMES_VERSION);
  assert.equal(target.runtime.versions_source, "VERSIONS.txt#HERMES_VERSION");
  assert.equal(runtimeVersionSupported(contract, target.runtime.declared_version), false);
  assert.equal(runtimeVersionSupported(target, contract.runtime.declared_version), false);
  assert.deepEqual([...target.adapter_surface], [...NATIVE_ADAPTER_SURFACE]);
  assert.equal(target.adapter_surface_status, "declared-unverified-against-real-hermes");
  const record = JSON.parse(readRepo("compatibility", "hermes.json"));
  assert.equal(record.legacy_fixture.version, contract.runtime.declared_version);
  assert.equal(record.legacy_fixture.version, versions.HERMES_LEGACY_FIXTURE_VERSION);
  assert.equal(record.legacy_fixture.live_verified, false);
  assert.equal(record.target.version, target.runtime.declared_version);
  assert.equal(record.target.commit, versions.HERMES_COMMIT);
  assert.equal(record.target.installer_url, versions.HERMES_INSTALLER_URL);
  assert.equal(record.target.installer_sha256, versions.HERMES_INSTALLER_SHA256);
  assert.equal(record.target.contract, path.relative(REPO, CANDIDATE_CONTRACT_PATH).split(path.sep).join("/"));
  assert.equal(record.target.status, "source-verified");
  assert.equal(record.target.live_verified, false, "no real-target run has happened; promotion policy is unchanged");
  assert.equal(record.promotion.required_consecutive_live_golden_days, 7);
  assert.equal(record.promotion.requires_explicit_review, true);
  assert.equal(record.promotion.automatic_version_bump, false);
});

test("runtime pin sources cannot be invented or used to mix the 0.22.5 and legacy CLI surfaces", () => {
  const target = JSON.parse(readFileSync(CANDIDATE_CONTRACT_PATH, "utf8"));
  const invented = structuredClone(target);
  invented.runtime.versions_source = "VERSIONS.txt#UNREVIEWED_VERSION";
  assert.ok(validateContract(invented).some((e) => /versions_source/.test(e)));
  const stale = structuredClone(target);
  stale.runtime.versions_source = "VERSIONS.txt#HERMES_CANDIDATE_VERSION";
  assert.ok(validateContract(stale).some((e) => /versions_source/.test(e)), "the removed candidate key is not accepted");
  const wrongPin = structuredClone(target);
  wrongPin.runtime.declared_version = contract.runtime.declared_version;
  wrongPin.runtime.supported_versions = [contract.runtime.declared_version];
  assert.ok(validateContract(wrongPin, { versions: readVersions() }).some((e) => /VERSIONS\.txt HERMES_VERSION/.test(e)));
  const wrongSurface = structuredClone(target);
  wrongSurface.adapter_surface = [...KNOWN_ADAPTER_SURFACE];
  assert.ok(validateContract(wrongSurface).some((e) => /adapter-surface/.test(e)));
  const legacy = raw();
  legacy.adapter_surface = [...NATIVE_ADAPTER_SURFACE];
  assert.ok(validateContract(legacy).some((e) => /adapter-surface/.test(e)));
});

test("no contract or declared adapter surface mentions the nonexistent `gateway run --daemon`; reload is `gateway restart`", () => {
  for (const surface of [KNOWN_ADAPTER_SURFACE, NATIVE_ADAPTER_SURFACE]) {
    assert.equal(surface.some((entry) => /daemon|gateway run|gateway stop|gateway start/.test(entry)), false, surface.join(","));
    assert.ok(surface.some((entry) => entry.startsWith("gateway restart")));
  }
  // v0.22.5: `gateway restart --detach` (`-y` only on operator opt-in), then readiness by `gateway ensure`; v2026.5.29.2 (0.15.2) has neither -y nor ensure.
  assert.deepEqual(NATIVE_ADAPTER_SURFACE.filter((entry) => entry.startsWith("gateway")), ["gateway restart --detach", "gateway restart -y --detach", "gateway ensure"]);
  assert.deepEqual(KNOWN_ADAPTER_SURFACE.filter((entry) => entry.startsWith("gateway")), ["gateway restart"]);
  for (const file of [DEFAULT_CONTRACT_PATH, CANDIDATE_CONTRACT_PATH]) assert.doesNotMatch(readFileSync(file, "utf8"), /--daemon/);
});

test("the cron prompt budget includes the `[hstack:<id>] ` marker the target prepends (native adapter rejects len(prompt) > 400)", () => {
  const marker = (c) => `[hstack:${c.schedule.id}]`;
  const withPromptOfLength = (c, effective) => { c.schedule.prompt = "a".repeat(effective - marker(c).length - 1); };
  const okLegacy = raw();
  withPromptOfLength(okLegacy, 400);
  assert.deepEqual(validateContract(okLegacy), [], "marker + space + prompt == 400 is accepted");
  for (const effective of [401, 410]) {
    const tooLong = raw();
    withPromptOfLength(tooLong, effective);
    assert.ok(tooLong.schedule.prompt.length <= 400, "still within the raw schema limit, so only the marker-aware rule can reject it");
    assert.ok(validateContract(tooLong).some((e) => /prompt/.test(e) && /marker/.test(e)), `effective ${effective}`);
  }
  // 378-400 raw characters is the window the audit found: valid before, unusable at apply after write-ahead.
  const window = raw();
  window.schedule.prompt = "a".repeat(390);
  assert.ok(validateContract(window).some((e) => /marker/.test(e)));
});

test("managed env keys are the exact names the Telegram and GitHub skills use", () => {
  const telegram = readRepo("skills", "platform-telegram", "SKILL.md");
  const github = readRepo("skills", "integration-github", "SKILL.md");
  const home = readRepo("skills", "hermes-home", "SKILL.md");
  assert.deepEqual(contract.managed_env_keys, ["GITHUB_TOKEN", "TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USERS", "TELEGRAM_HOME_CHANNEL"]);
  assert.match(github, /\bGITHUB_TOKEN\b/);
  for (const key of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USERS", "TELEGRAM_HOME_CHANNEL"]) assert.match(telegram, new RegExp(`\\b${key}\\b`), key);
  assert.match(home, /\bTELEGRAM_HOME_CHANNEL\b/);
  assert.equal(contract.destination.env_key, "TELEGRAM_HOME_CHANNEL");
  assert.equal(contract.destination.allow_var, "TELEGRAM_ALLOWED_USERS");
  assert.equal(contract.managed_env_keys.includes("TELEGRAM_ENABLED"), false, "TELEGRAM_ENABLED is not an upstream variable and must never be managed");
});

test("managed skills exist in the catalogue and match the recipe's connector-to-skill map", () => {
  const recipe = JSON.parse(readRepo("recipes", "founder-brief", "recipe.json"));
  for (const skill of contract.managed_skills) {
    assert.doesNotThrow(() => readRepo("skills", skill, "SKILL.md"), skill);
  }
  assert.equal(recipe.skills.by_connector.github, contract.adapters.github.skill);
  assert.equal(recipe.skills.by_connector.telegram, contract.adapters.telegram.skill);
  assert.deepEqual(contract.managed_skills.slice(2), recipe.skills.always, "the recipe's always-skills follow the adapter skills");
  assert.deepEqual(contract.plan_source.source_ids, ["github"]);
  assert.deepEqual(contract.plan_source.delivery_ids, ["telegram"]);
  assert.ok(recipe.connector_rules.sources.ids.includes("github"));
  assert.ok(recipe.connector_rules.deliveries.ids.includes("telegram"));
});

test("the adapter surface is only the declared hermes subcommands and is marked unverified", () => {
  assert.deepEqual([...contract.adapter_surface], [...KNOWN_ADAPTER_SURFACE]);
  assert.equal(contract.adapter_surface_status, "declared-unverified-against-real-hermes");
  for (const forbidden of ["doctor", "--fix", "config get"]) {
    assert.equal(contract.adapter_surface.some((entry) => entry.includes(forbidden)), false, forbidden);
  }
});

test("delivery semantics and scope note make no exactly-once or health claim", () => {
  assert.match(contract.delivery_semantics, /best-effort/);
  assert.match(contract.delivery_semantics, /duplicates possible/);
  assert.match(contract.delivery_semantics, /exactly-once is not claimed/);
  assert.match(contract.scope_note, /only the listed checks/);
});

test("unknown keys are rejected at every level", () => {
  assert.throws(withContract((c) => { c.extra = 1; }), ContractInvalid);
  assert.throws(withContract((c) => { c.runtime.channel = "stable"; }), ContractInvalid);
  assert.throws(withContract((c) => { c.adapters.github.write = true; }), ContractInvalid);
  assert.throws(withContract((c) => { c.schedule.catchup = true; }), ContractInvalid);
  assert.throws(withContract((c) => { delete c.scope_note; }), ContractInvalid);
});

test("duplicate keys in the contract file are rejected", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hstack-contract-"));
  try {
    const text = readFileSync(DEFAULT_CONTRACT_PATH, "utf8").replace('"recipe": "founder-brief-github-telegram",', '"recipe": "founder-brief-github-telegram", "recipe": "other",');
    const file = path.join(dir, "c.json");
    writeFileSync(file, text);
    assert.throws(() => loadContract(file), /duplicate JSON key/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("semantic rules: read-only GitHub, linux/ssh/bash, safe schedule prompt, required checks complete, surface known", () => {
  const bad = (mutate) => validateContract((() => { const c = raw(); mutate(c); return c; })());
  assert.ok(bad((c) => { c.adapters.github.access = "read_write"; }).length > 0);
  assert.ok(bad((c) => { c.target.os = "darwin"; }).length > 0);
  assert.ok(bad((c) => { c.schedule.prompt = "send $(whoami) | tee"; }).some((e) => e.includes("prompt")));
  assert.ok(bad((c) => { c.schedule.prompt = "it's quoted"; }).some((e) => e.includes("prompt")));
  assert.ok(bad((c) => { c.adapter_surface.push("doctor"); }).length > 0);
  assert.ok(bad((c) => { c.adapter_surface.push("config set"); }).some((e) => e.includes("duplicate")));
  assert.ok(bad((c) => { c.required_checks = c.required_checks.filter((id) => id !== "env-boundary"); }).length > 0);
  assert.ok(bad((c) => { c.managed_env_keys = c.managed_env_keys.filter((k) => k !== "TELEGRAM_HOME_CHANNEL"); }).length > 0);
  assert.ok(bad((c) => { c.managed_skills = c.managed_skills.filter((k) => k !== "platform-telegram"); }).length > 0);
  assert.ok(bad((c) => { c.destination.id_pattern = "("; }).length > 0);
  assert.deepEqual(bad(() => {}), []);
});

test("contract_hash is stable and changes with any content change", () => {
  const a = contractHash(contract);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(contractHash(raw()), a);
  const changed = raw();
  changed.schedule.prompt += " Extra.";
  assert.notEqual(contractHash(changed), a);
});

test("the shipped contract is immutable after loading", () => {
  assert.throws(() => { "use strict"; contract.schedule.prompt = "changed"; }, TypeError);
  assert.throws(() => { "use strict"; contract.managed_env_keys.push("X"); }, TypeError);
});
