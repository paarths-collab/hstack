import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { it } from "node:test";
import { REPO_ROOT, loadBlocks } from "./helpers/blocks.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures/hermes-v0.22.5");
const provenance = JSON.parse(readFileSync(path.join(fixture, "provenance.json"), "utf8"));

it("exact tagged syntax fixtures and installer are bound to the single supported target in VERSIONS.txt", () => {
  const versions = readFileSync(path.join(REPO_ROOT, "VERSIONS.txt"), "utf8");
  assert.ok(versions.includes(`HERMES_VERSION=${provenance.version}\n`));
  assert.ok(versions.includes(`HERMES_COMMIT=${provenance.commit}\n`));
  assert.ok(versions.includes(`HERMES_INSTALLER_URL=https://raw.githubusercontent.com/NousResearch/hermes-agent/${provenance.commit}/scripts/install.sh\n`));
  assert.ok(versions.includes(`HERMES_INSTALLER_SHA256=${provenance.files["install.sh"].sha256}\n`));
  assert.doesNotMatch(versions, /HERMES_LEGACY_FIXTURE_VERSION=/, "retired workflow fixtures do not retain a runtime pin");
  assert.doesNotMatch(versions, /HERMES_CANDIDATE_/, "the candidate keys are gone");
  for (const [name, meta] of Object.entries(provenance.files)) {
    const bytes = readFileSync(path.join(fixture, name));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), meta.sha256, name);
    assert.equal(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), meta.git_blob_sha, name);
  }
  const installer = readFileSync(path.join(REPO_ROOT, "skills/hermes-install/SKILL.md"), "utf8");
  assert.ok(installer.includes(provenance.commit), "the install skill pins the same commit as the fixtures");
  assert.ok(installer.includes(provenance.files["install.sh"].sha256), "and the same installer digest");
  assert.ok(!loadBlocks("hermes-install").some(b => /pip install|\/main\/scripts\/install/.test(b.code)));
  for (const skill of ["hermes-install", "hermes-update", "hermes-deploy", "hermes-memory"]) {
    const text = readFileSync(path.join(REPO_ROOT, `skills/${skill}/SKILL.md`), "utf8");
    assert.doesNotMatch(text, /CANDIDATE_ACKNOWLEDGED|compatibility candidate|unpromoted/i, `${skill}: the opt-in framing is retired`);
    assert.match(text, /## Verified against Hermes v0\.22\.5/, skill);
    assert.match(text, /not live-verified|source-verified/i, `${skill}: says honestly that nothing was run live`);
  }
});

it("actual v0.22.5 parsers accept migrated commands and reject retired daemon/memory/update assumptions", () => {
  const accepted = [
    ["gateway", "stop"], ["gateway", "start"],
    ["gateway", "ensure", "--json", "--timeout", "60"],
    ["gateway", "install", "--if-missing", "--no-start-now"],
    ["config", "set", "model.provider", "openrouter"],
    ["config", "set", "model.default", "example/model"],
    ["config", "set", "TELEGRAM_HOME_CHANNEL", "--", "-1001234567890"],
    ["model"], ["setup", "--portal"],
    ["memory", "status"], ["memory", "off"], ["memory", "setup", "mem0"],
    ["update", "--plan"], ["update", "--channel", "stable", "--check"],
    ["update", "--channel", "stable", "--backup", "--yes"],
    ["update", "--channel", "stable", "--yes"],
    ["update", "--check"],
    ["backup", "--output", "/tmp/x.zip", "--keep", "0"],
    ["import", "/tmp/x.zip"],
    ["doctor"],
    ["memory", "off"], ["memory", "status"],
    ["plugins", "install", "mem0", "--yes-deps", "--no-enable"],
    ["-z", "reply with the single word OK"],
  ];
  const rejected = [
    ["gateway", "run", "--daemon"], ["gateway", "ensure", "--daemon"],
    ["memory", "write", "--note", "test"], ["memory", "search", "test"],
    ["update", "--version", "0.22.5"], ["model", "--provider", "openrouter"],
    ["setup", "--portal", "--no-browser"],
    ["backup", "--keep", "-1"],
    ["plugins", "install", "mem0", "--yes-deps", "--no-deps"],
    ["plugins", "install", "mem0", "--enable", "--no-enable"],
    ["pm", "doctor"], // `pm` never reaches argparse (hermes_cli/main.py:679-683): skills mark those lines `hermes-parse: skip`
  ];
  const r = spawnSync("python3", [path.join(here, "helpers/native-parser.py"), fixture, JSON.stringify([...accepted, ...rejected].map(argv => ["-p", "default", ...argv]))], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const parsed = JSON.parse(r.stdout);
  for (let i = 0; i < parsed.length; i++) {
    const row = parsed[i];
    if (i < accepted.length) { assert.equal(row.code, 0, JSON.stringify(row)); assert.equal(row.explicit_profile, "default"); assert.equal(row.selected_profile, ".hermes"); }
    else assert.notEqual(row.code, 0, JSON.stringify(row));
  }
});

it("actual immutable installer accepts the v0.22.5 flags before help and refuses unsupported arguments without running stages", () => {
  const r = spawnSync("/bin/bash", [path.join(fixture, "install.sh"), "--commit", provenance.commit, "--channel", "stable", "--non-interactive", "--skip-browser", "--skip-computer-use", "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--commit SHA/);
  const bad = spawnSync("/bin/bash", [path.join(fixture, "install.sh"), "--unsupported-syntax-test"], { encoding: "utf8" });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /unknown option/);
});

it("actual tagged early profile selection follows sticky state unless the migrated calls explicitly bind default", () => {
  const r = spawnSync("python3", [path.join(here, "helpers/native-parser.py"), fixture, JSON.stringify([["config", "show"], ["-p", "default", "config", "show"]])], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const [sticky, bound] = JSON.parse(r.stdout);
  assert.equal(sticky.code, 0);
  assert.equal(sticky.selected_profile, "work", "control: root HERMES_HOME alone still follows active_profile");
  assert.equal(bound.code, 0);
  assert.equal(bound.selected_profile, ".hermes");
  assert.equal(bound.explicit_profile, "default");
  for (const skill of ["hermes-install", "hermes-update", "hermes-memory", "hermes-model", "hermes-deploy", "integration-github", "integration-notion", "platform-telegram"]) {
    const code = loadBlocks(skill).map(b => b.code).join("\n");
    assert.doesNotMatch(code, /(?:\bhermes|"\$H") (?:config|gateway|memory|plugins|backup|update|pm|doctor|logs|-z|mcp)\b/, `${skill}: unbound native call`);
  }
});
