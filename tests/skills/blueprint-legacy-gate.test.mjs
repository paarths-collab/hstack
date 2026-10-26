// /blueprint-install and /blueprint-saas-founder chain specialist skills. A specialist that still carries the legacy
// compatibility marker (its reload / `mcp add` forms may not exist on Hermes 0.22.5) must be refused unless the user
// sets ALLOW_LEGACY=1 knowingly. Same refusal as /hermes-integrate. Local only: no ssh, nothing written.
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { REPO_ROOT, assemble, loadBlocks } from "./helpers/blocks.mjs";
import { scenario } from "./helpers/sandbox.mjs";

const MARKER = "> **Compatibility:** legacy procedure written for Hermes 0.15.x — not yet re-verified on Hermes 0.22.5. Commands such as `gateway run --daemon` in older copies do not exist on 0.22.5; prefer /hermes-restart for reloads.";
const VALIDATOR = path.join(REPO_ROOT, "skills", "blueprint-install", "scripts", "validate_blueprint.py");
const BLUEPRINT = path.join(REPO_ROOT, "blueprints", "saas-founder.hstack-blueprint.json"); // resolves to platform-telegram, integration-stripe/posthog/sentry/github, hermes-home, hermes-cron
const skillFile = (name, legacy) => `---\nname: ${name}\ndescription: fixture\n---\n\n# /${name}\n${legacy ? `\n${MARKER}\n` : ""}\nbody\n`;
const env = { BLUEPRINT_PATH: BLUEPRINT, VALIDATOR, HSTACK_ROOT: "/nonexistent-hstack-root" };
const setupSkills = (legacyNames) => (sb) => {
  for (const n of ["platform-telegram", "integration-stripe", "integration-posthog", "integration-sentry", "integration-github", "hermes-home", "hermes-cron"]) {
    sb.write(`.claude/skills/${n}/SKILL.md`, skillFile(n, legacyNames.includes(n)));
  }
};

describe("blueprint-install Step 1b refuses legacy-marked specialists", { concurrency: 4 }, () => {
  const ids = loadBlocks("blueprint-install").map((b) => b.id);
  it("the gate block exists", () => assert.ok(ids.includes("step1b#1"), ids.join(",")));
  const script = assemble(["set +e\n", { skill: "blueprint-install", ids: ["step1b#1"] }, 'echo "SCRIPT-COMPLETED"\n']);

  it("refuses and names the legacy specialists; nothing is written and no ssh call is made", async () => {
    await scenario({ name: "bp-legacy", script, env, setup: setupSkills(["integration-stripe", "integration-sentry"]) }, async (run) => {
      assert.match(run.out, /ABORT: still legacy procedures[^\n]*: integration-stripe integration-sentry\./);
      assert.ok(!run.completed, "the gate must exit before the rest of the skill runs");
      assert.equal(run.sb.sshCalls().length, 0);
      assert.deepEqual(run.after, run.before);
    });
  });
  it("ALLOW_LEGACY=1 proceeds with a visible warning", async () => {
    await scenario({ name: "bp-legacy-ok", script, env: { ...env, ALLOW_LEGACY: "1" }, setup: setupSkills(["integration-stripe"]) }, async (run) => {
      assert.ok(run.completed, run.out);
      assert.match(run.out, /WARN: ALLOW_LEGACY=1[^\n]*integration-stripe/);
    });
  });
  it("modernized specialists pass silently", async () => {
    await scenario({ name: "bp-clean", script, env, setup: setupSkills([]) }, async (run) => {
      assert.ok(run.completed, run.out);
      assert.doesNotMatch(run.out, /ABORT|WARN/);
    });
  });
  it("a specialist that is not installed anywhere is a NOTE, not a pass or a crash", async () => {
    await scenario({ name: "bp-missing", script, env, setup: (sb) => sb.write(".claude/skills/hermes-home/SKILL.md", skillFile("hermes-home", false)) }, async (run) => {
      assert.ok(run.completed, run.out);
      assert.match(run.out, /NOTE: integration-stripe is not installed/);
    });
  });
  it("control: without the gate the legacy plan would run (the abort comes from the gate itself)", async () => {
    const noGate = assemble(["set +e\n", { skill: "blueprint-install", ids: ["step1b#1"], replace: [['if [ -n "$LEGACY" ] && [ "${ALLOW_LEGACY:-0}" != 1 ]; then', "if false; then"]] }, 'echo "SCRIPT-COMPLETED"\n']);
    await scenario({ name: "bp-control", script: noGate, env, setup: setupSkills(["integration-stripe"]) }, async (run) => {
      assert.ok(run.completed, run.out);
      assert.doesNotMatch(run.out, /ABORT/);
    });
  });
});

describe("blueprint-saas-founder flags legacy shortlist entries before recommending them", () => {
  const ids = loadBlocks("blueprint-saas-founder").map((b) => b.id);
  it("has the check, and it reports exactly the legacy ones", async () => {
    const id = ids.find((i) => /^step2/.test(i));
    assert.ok(id, ids.join(","));
    const script = assemble(["set +e\n", { skill: "blueprint-saas-founder", ids: [id] }, 'echo "SCRIPT-COMPLETED"\n']);
    await scenario({ name: "bp-founder", script, env: {}, setup: setupSkills(["integration-sentry", "integration-github"]) }, async (run) => {
      assert.ok(run.completed, run.out);
      assert.match(run.out, /LEGACY: integration-sentry/);
      assert.match(run.out, /LEGACY: integration-github/);
      assert.doesNotMatch(run.out, /LEGACY: integration-stripe|LEGACY: integration-posthog/);
    });
  });
});
