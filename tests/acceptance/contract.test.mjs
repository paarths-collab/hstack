import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ContractInvalid, DEFAULT_CONTRACT_PATH, DEFAULT_VERSIONS_PATH, KNOWN_ADAPTER_SURFACE, contractHash, loadContract,
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

test("the shipped contract declares the Hermes version read from VERSIONS.txt, and the two agree", () => {
  const fromFile = /^HERMES_VERSION=(.+)$/m.exec(readRepo("VERSIONS.txt"))[1].trim();
  assert.equal(contract.runtime.declared_version, fromFile);
  assert.deepEqual(contract.runtime.supported_versions, [fromFile]);
  assert.equal(readVersions(DEFAULT_VERSIONS_PATH).HERMES_VERSION, fromFile);
  const pkg = /^GITHUB_MCP_PKG=(.+)$/m.exec(readRepo("VERSIONS.txt"))[1].trim();
  assert.equal(contract.adapters.github.mcp_pkg, pkg);
  assert.equal(runtimeVersionSupported(contract, fromFile), true);
  assert.equal(runtimeVersionSupported(contract, "0.15.3"), false);
  assert.equal(runtimeVersionSupported(contract, "unknown"), false);
});

test("loading enforces agreement with VERSIONS.txt: a drifted contract is rejected", () => {
  assert.throws(withContract((c) => { c.runtime.declared_version = "0.15.3"; c.runtime.supported_versions = ["0.15.3"]; }), (error) => {
    assert.ok(error instanceof ContractInvalid);
    assert.match(error.message, /disagrees with VERSIONS\.txt HERMES_VERSION/);
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
  for (const forbidden of ["doctor", "--fix", "restart", "config get"]) {
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
