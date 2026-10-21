// The acceptance contract: the single, versioned statement of what one transaction may do.
// Everything that reaches the target (schedule, cron prompt, destination key, managed env keys,
// managed skills) comes from this file, never from blueprint text or retrieved content.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalHash, evaluateSchema, parseStrictJson } from "./receipt.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "..", "..");
export const DEFAULT_CONTRACT_PATH = path.join(REPO_ROOT, "acceptance", "founder-brief-github-telegram.contract.json");
export const DEFAULT_VERSIONS_PATH = path.join(REPO_ROOT, "VERSIONS.txt");

/** The only hermes subcommands the target script is allowed to call (declared, unverified for real Hermes). */
export const KNOWN_ADAPTER_SURFACE = Object.freeze([
  "--version", "cron list", "cron create", "cron remove", "cron run",
  "gateway stop", "gateway run --daemon", "config set",
]);

export const KNOWN_CHECK_IDS = Object.freeze([
  "runtime-version", "env-boundary", "schedule-single", "managed-skills-intact",
  "unrelated-state-unchanged", "private-destination-delivery", "untrusted-input-boundary",
]);

const SAFE_PROMPT = /^[A-Za-z0-9 _.,:=+@%/*-]{1,400}$/;

const str = (pattern, extra = {}) => ({ type: "string", pattern, ...extra });
const obj = (required, properties) => ({ type: "object", additionalProperties: false, required, properties });
const strList = (pattern, minItems = 1) => ({ type: "array", minItems, items: str(pattern) });

const CONTRACT_SCHEMA = obj(
  [
    "acceptance_schema_version", "recipe", "plan_source", "runtime", "adapters", "target", "destination",
    "managed_env_keys", "managed_skills", "schedule", "adapter_surface", "adapter_surface_status",
    "required_checks", "delivery_semantics", "scope_note",
  ],
  {
    acceptance_schema_version: { const: 1 },
    recipe: str("^[a-z0-9][a-z0-9-]{0,63}$"),
    plan_source: obj(
      ["compiler", "recipe_file", "source_ids", "delivery_ids", "expected_installation", "expected_automation_id", "expected_policy"],
      {
        compiler: str("^[A-Za-z0-9_./#-]+$"),
        recipe_file: str("^[A-Za-z0-9_./-]+$"),
        source_ids: strList("^[a-z0-9-]+$"),
        delivery_ids: strList("^[a-z0-9-]+$"),
        expected_installation: { enum: ["existing_agent"] },
        expected_automation_id: str("^[a-z0-9-]+$"),
        expected_policy: { enum: ["approval_required"] },
      },
    ),
    runtime: obj(["name", "declared_version", "supported_versions", "versions_source"], {
      name: { enum: ["hermes"] },
      declared_version: str("^[0-9]+\\.[0-9]+\\.[0-9]+$"),
      supported_versions: strList("^[0-9]+\\.[0-9]+\\.[0-9]+$"),
      versions_source: str("^VERSIONS\\.txt#[A-Z0-9_]+$"),
    }),
    adapters: obj(["github", "telegram"], {
      github: obj(["skill", "access", "mcp_pkg", "mcp_pkg_source"], {
        skill: str("^[a-z0-9][a-z0-9-]*$"),
        access: { enum: ["read_only"] },
        mcp_pkg: str("^[A-Za-z0-9@._/+-]{1,120}$"),
        mcp_pkg_source: str("^VERSIONS\\.txt#[A-Z0-9_]+$"),
      }),
      telegram: obj(["skill"], { skill: str("^[a-z0-9][a-z0-9-]*$") }),
    }),
    target: obj(["os", "transport", "shell"], {
      os: { enum: ["linux"] },
      transport: { enum: ["ssh"] },
      shell: { enum: ["bash"] },
    }),
    destination: obj(["platform", "env_key", "allow_var", "id_pattern"], {
      platform: { enum: ["telegram"] },
      env_key: str("^[A-Z][A-Z0-9_]*$"),
      allow_var: str("^[A-Z][A-Z0-9_]*$"),
      id_pattern: { type: "string", minLength: 1, maxLength: 64 },
    }),
    managed_env_keys: strList("^[A-Z][A-Z0-9_]*$"),
    managed_skills: strList("^[a-z0-9][a-z0-9-]*$"),
    schedule: obj(["id", "cron_pattern", "prompt"], {
      id: str("^[a-z0-9-]+$"),
      cron_pattern: { type: "string", minLength: 1, maxLength: 64 },
      prompt: { type: "string", minLength: 1, maxLength: 400 },
    }),
    adapter_surface: strList("^[a-z-]+( [a-z]+)?( --[a-z]+)?$"),
    adapter_surface_status: { enum: ["declared-unverified-against-real-hermes"] },
    required_checks: strList("^[a-z][a-z0-9-]*$"),
    delivery_semantics: { type: "string", minLength: 1, maxLength: 300 },
    scope_note: { type: "string", minLength: 1, maxLength: 600 },
  },
);

export class ContractInvalid extends Error {
  constructor(errors) {
    super(`contract invalid: ${errors.slice(0, 5).join("; ")}${errors.length > 5 ? "; ..." : ""}`);
    this.name = "ContractInvalid";
    this.errors = errors;
  }
}

/** Parse VERSIONS.txt text: KEY=value lines, comments and blank lines ignored. */
export function parseVersions(text) {
  const result = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    result[line.slice(0, index)] = line.slice(index + 1);
  }
  return result;
}

export function readVersions(file = DEFAULT_VERSIONS_PATH) {
  return parseVersions(readFileSync(file, "utf8"));
}

function isUnique(list) {
  return new Set(list).size === list.length;
}

/** Returns an array of error strings (empty when the contract is valid). `versions` is a parsed VERSIONS.txt or null. */
export function validateContract(contract, { versions = null } = {}) {
  const errors = [];
  evaluateSchema(contract, CONTRACT_SCHEMA, "contract", errors);
  if (errors.length > 0) return errors;

  const c = contract;
  for (const [name, list] of [
    ["managed_env_keys", c.managed_env_keys], ["managed_skills", c.managed_skills],
    ["adapter_surface", c.adapter_surface], ["required_checks", c.required_checks],
  ]) {
    if (!isUnique(list)) errors.push(`contract.${name}: duplicate entries`);
  }
  if (!c.runtime.supported_versions.includes(c.runtime.declared_version)) {
    errors.push("contract.runtime.supported_versions must include declared_version");
  }
  if (!c.managed_env_keys.includes(c.destination.env_key)) errors.push("contract.destination.env_key must be a managed env key");
  if (!c.managed_env_keys.includes(c.destination.allow_var)) errors.push("contract.destination.allow_var must be a managed env key");
  for (const skill of [c.adapters.github.skill, c.adapters.telegram.skill]) {
    if (!c.managed_skills.includes(skill)) errors.push(`contract.managed_skills must include adapter skill ${skill}`);
  }
  for (const entry of c.adapter_surface) {
    if (!KNOWN_ADAPTER_SURFACE.includes(entry)) errors.push(`contract.adapter_surface: '${entry}' is not a known adapter-surface entry`);
  }
  for (const id of c.required_checks) {
    if (!KNOWN_CHECK_IDS.includes(id)) errors.push(`contract.required_checks: unknown check '${id}'`);
  }
  for (const id of KNOWN_CHECK_IDS) {
    if (!c.required_checks.includes(id)) errors.push(`contract.required_checks must include '${id}'`);
  }
  for (const regexSource of [c.destination.id_pattern, c.schedule.cron_pattern]) {
    try {
      new RegExp(regexSource);
    } catch {
      errors.push("contract: a pattern field is not a valid regular expression");
    }
  }
  if (!SAFE_PROMPT.test(c.schedule.prompt)) {
    errors.push("contract.schedule.prompt may only contain letters, digits, spaces and . , : = + @ % / * _ -");
  }
  if (c.schedule.prompt.includes("|")) errors.push("contract.schedule.prompt must not contain '|'");

  if (versions) {
    if (versions.HERMES_VERSION !== c.runtime.declared_version) {
      errors.push(`contract.runtime.declared_version (${c.runtime.declared_version}) disagrees with VERSIONS.txt HERMES_VERSION (${versions.HERMES_VERSION ?? "missing"})`);
    }
    if (!c.runtime.supported_versions.every((v) => v === versions.HERMES_VERSION)) {
      errors.push("contract.runtime.supported_versions disagrees with VERSIONS.txt HERMES_VERSION");
    }
    if (versions.GITHUB_MCP_PKG !== c.adapters.github.mcp_pkg) {
      errors.push(`contract.adapters.github.mcp_pkg disagrees with VERSIONS.txt GITHUB_MCP_PKG (${versions.GITHUB_MCP_PKG ?? "missing"})`);
    }
  }
  return errors;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Load and strictly validate a contract file.
 * options.versionsFile: when given (or when the default repo VERSIONS.txt exists and options.versionsFile !== null),
 * the declared Hermes version and GitHub MCP pin must equal VERSIONS.txt.
 */
export function loadContract(file = DEFAULT_CONTRACT_PATH, options = {}) {
  let parsed;
  try {
    parsed = parseStrictJson(readFileSync(file, "utf8"));
  } catch (error) {
    throw new ContractInvalid([`cannot parse ${path.basename(file)}: ${error.message}`]);
  }
  let versions = null;
  if (options.versionsFile !== null) {
    const versionsFile = options.versionsFile ?? DEFAULT_VERSIONS_PATH;
    try {
      versions = readVersions(versionsFile);
    } catch (error) {
      if (options.versionsFile !== undefined) throw new ContractInvalid([`cannot read versions file: ${error.message}`]);
    }
  }
  const errors = validateContract(parsed, { versions });
  if (errors.length > 0) throw new ContractInvalid(errors);
  return deepFreeze(parsed);
}

export function contractHash(contract) {
  return canonicalHash(contract);
}

/** True when an observed `hermes --version` string is one the contract supports. */
export function runtimeVersionSupported(contract, version) {
  return contract.runtime.supported_versions.includes(version);
}
