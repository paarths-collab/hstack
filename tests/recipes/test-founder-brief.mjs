import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  RecipeCompilerError,
  compileFounderBrief,
  getReadiness,
  stringifyBlueprint,
  validateRecipeCatalog,
} from "../../packages/recipe-core/index.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDirectory, "../..");
const recipe = JSON.parse(
  readFileSync(path.join(repoRoot, "recipes", "founder-brief", "recipe.json"), "utf8"),
);
const publicRegistry = JSON.parse(
  readFileSync(path.join(repoRoot, "recipes", "registry.json"), "utf8"),
);

function collectJsonFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return collectJsonFiles(target);
    }
    return entry.name.endsWith(".json") ? [target] : [];
  });
}

const connectors = collectJsonFiles(path.join(repoRoot, "connectors"))
  .map((file) => JSON.parse(readFileSync(file, "utf8")));

test("Founder Brief catalog is connected only to real official skills", () => {
  const canonical = validateRecipeCatalog({ recipe, connectors });
  assert.equal(canonical.status, "contract-tested");

  for (const connector of connectors) {
    assert.equal(connector.optional, true, `${connector.id} must remain individually optional`);
    const skill = connector.skill ?? connector.hstack_skill;
    assert.match(skill, /^(integration|platform)-/);
    assert.equal(
      existsSync(path.join(repoRoot, "skills", skill, "SKILL.md")),
      true,
      `${connector.id} must map to an existing official skill`,
    );
  }
});

test("the browser registry resolves only reviewed recipe and connector records", () => {
  assert.ok(Array.isArray(publicRegistry.recipes), "registry.recipes must be an array");
  assert.equal(typeof publicRegistry.connectors, "object", "registry.connectors must group connector records");

  const registryRoot = path.join(repoRoot, "recipes");
  const resolveEntry = (entry) => {
    assert.equal(typeof entry?.id, "string");
    assert.equal(typeof entry?.path, "string");
    const resolved = path.resolve(registryRoot, entry.path);
    assert.ok(resolved.startsWith(path.resolve(repoRoot) + path.sep), "registry path must stay inside the repository");
    assert.equal(existsSync(resolved), true, `registry file for '${entry.id}' must exist`);
    return JSON.parse(readFileSync(resolved, "utf8"));
  };

  const founderEntry = publicRegistry.recipes.find((item) => item.id === "founder-brief");
  const registryRecipe = resolveEntry(founderEntry);
  assert.deepEqual(registryRecipe, recipe, "the Composer must load the reviewed Founder Brief data");

  const connectorEntries = Object.values(publicRegistry.connectors).flat();
  const registryConnectors = new Map(connectorEntries.map((entry) => [entry.id, resolveEntry(entry)]));
  assert.equal(registryConnectors.size, connectors.length);
  for (const connector of connectors) {
    assert.deepEqual(
      registryConnectors.get(connector.id),
      connector,
      `registry connector '${connector.id}' must match its reviewed source file`,
    );
  }
});

test("a no-connector selection remains an honest non-deployable preview", () => {
  const result = compileFounderBrief({ recipe, connectors, selection: {} });
  assert.equal(result.state, "preview");
  assert.equal(result.deployable, false);
  assert.equal(result.blueprint, undefined);
  assert.match(result.messages.join(" "), /Preview mode/);
});

test("one optional source plus one optional destination produces a valid safe plan", () => {
  const result = compileFounderBrief({
    recipe,
    connectors,
    selection: {
      sourceIds: ["github"],
      deliveryIds: ["telegram"],
      cadence: "weekdays",
    },
  });

  assert.equal(result.deployable, true);
  assert.deepEqual(result.blueprint.integrations, [
    { id: "github", skill: "integration-github", access: "read_only" },
  ]);
  assert.deepEqual(result.blueprint.delivery, { mode: "platforms", channels: ["telegram"] });
  assert.deepEqual(result.blueprint.automations, [
    { id: "morning-briefing", enabled: true, cadence: "Weekdays, chosen time" },
  ]);
  assert.deepEqual(result.blueprint.policies, {
    external_messages: "approval_required",
    destructive_actions: "approval_required",
    safe_operations: "approval_required",
  });
  assert.deepEqual(result.blueprint.resolved_skills, [
    "platform-telegram",
    "integration-github",
    "hermes-home",
    "hermes-cron",
  ]);
  assert.doesNotMatch(stringifyBlueprint(result), /(sk_live|ghp_|xoxb-|xapp-|AIza)/);
});

test("the generated plan passes the existing blueprint safety validator", () => {
  const result = compileFounderBrief({
    recipe,
    connectors,
    selection: {
      sourceIds: ["sentry", "notion"],
      deliveryIds: ["slack"],
      cadence: "weekly",
    },
  });
  const tempDirectory = mkdtempSync(path.join(os.tmpdir(), "agent-recipes-test-"));
  const blueprintPath = path.join(tempDirectory, result.fileName);
  try {
    writeFileSync(blueprintPath, stringifyBlueprint(result));
    execFileSync(
      "py",
      [
        path.join(repoRoot, "skills", "blueprint-install", "scripts", "validate_blueprint.py"),
        blueprintPath,
        "--json",
      ],
      { encoding: "utf8", stdio: "pipe" },
    );
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test("unsafe or incomplete combinations cannot become deployment plans", () => {
  const sourceOnly = getReadiness({
    recipe,
    connectors,
    selection: { sourceIds: ["stripe"] },
  });
  assert.equal(sourceOnly.deployable, false);
  assert.equal(sourceOnly.state, "preview");

  assert.throws(
    () => compileFounderBrief({
      recipe,
      connectors,
      selection: { sourceIds: ["stripe"], cadence: "weekdays" },
    }),
    RecipeCompilerError,
  );
  assert.throws(
    () => compileFounderBrief({
      recipe,
      connectors,
      selection: { sourceIds: ["not-a-real-connector"], deliveryIds: ["slack"] },
    }),
    RecipeCompilerError,
  );
  assert.throws(
    () => compileFounderBrief({
      recipe,
      connectors,
      selection: { sourceIds: ["github", "github"], deliveryIds: ["telegram"] },
    }),
    RecipeCompilerError,
  );
});
