// Untrusted blueprint text.
//
// A blueprint's name, description, credential_requirements text and automation cadence labels
// are DISPLAY DATA. deriveExecutionGraph reads only allowlisted structural fields, by explicit
// property access (never enumeration, never serialisation), so display text cannot influence what
// runs, where a message goes, or what is hashed. The schedule, cron prompt, destination key,
// managed env keys and managed skills come from the contract; the chat id and cron schedule come
// from a validated OPERATOR input, never from the blueprint.

import { canonicalHash, destinationFingerprint, sha256Hex } from "./receipt.js";
import { contractHash } from "./contract.js";

export class BlueprintRejected extends Error {
  constructor(code, field) {
    // Only structural field names appear in the message, never blueprint display text.
    super(`${code}: ${field}`);
    this.name = "BlueprintRejected";
    this.code = code;
    this.blocked_reason = "invalid_blueprint";
    this.field = field;
  }
}

export class OperatorInputInvalid extends Error {
  constructor(field, message) {
    super(`operator input '${field}': ${message}`);
    this.name = "OperatorInputInvalid";
    this.field = field;
  }
}

/** Validate operator-supplied destination and schedule against the contract. Never echoes the chat id. */
export function validateOperatorInput(contract, input) {
  const chatId = input?.chatId;
  const schedule = input?.schedule;
  if (typeof chatId !== "string" || chatId.length > 24 || !new RegExp(contract.destination.id_pattern).test(chatId)) {
    throw new OperatorInputInvalid("chatId", "must be a numeric Telegram chat id matching the contract pattern");
  }
  if (typeof schedule !== "string" || schedule.length > 64) {
    throw new OperatorInputInvalid("schedule", "must be a five-field cron expression such as '0 8 * * 1-5'");
  }
  if (schedule.trim().startsWith("-")) {
    throw new OperatorInputInvalid("schedule", "must not start with '-' (the target would read it as an option)");
  }
  if (!new RegExp(contract.schedule.cron_pattern).test(schedule)) {
    throw new OperatorInputInvalid("schedule", "may only contain digits, '*', '/', ',', '-' and spaces");
  }
  const normalised = schedule.trim().replace(/ +/g, " ");
  const fields = normalised.split(" ");
  if (fields.length !== 5) {
    throw new OperatorInputInvalid("schedule", "must have exactly five cron fields (minute hour day month weekday)");
  }
  if (!fields.every((field) => /^[0-9*][0-9*/,-]*$/.test(field))) {
    throw new OperatorInputInvalid("schedule", "each cron field must start with a digit or '*'");
  }
  return { chatId, schedule: normalised, destinationFingerprint: destinationFingerprint(chatId) };
}

function expectEqual(actual, expected, field) {
  if (actual !== expected) throw new BlueprintRejected("unexpected_value", field);
}

/** Copy an array by index so only `length` and numeric keys of the untrusted value are ever read. */
function expectList(value, field) {
  if (!Array.isArray(value)) throw new BlueprintRejected("expected_array", field);
  const length = value.length;
  if (!Number.isInteger(length) || length > 64) throw new BlueprintRejected("unexpected_value", field);
  const copy = [];
  for (let index = 0; index < length; index += 1) copy.push(value[index]);
  return copy;
}

/** The skills the contract says this plan needs, in the compiler's order, re-derived from structure. */
function deriveSkills(contract, channels, automationCount) {
  const skills = [];
  for (const channel of channels) {
    if (channel === contract.destination.platform) skills.push(contract.adapters.telegram.skill);
    else throw new BlueprintRejected("unsupported_channel", "delivery.channels");
  }
  skills.push(contract.adapters.github.skill);
  if (channels.length > 0) skills.push("hermes-home");
  if (automationCount > 0) skills.push("hermes-cron");
  for (const skill of skills) {
    if (!contract.managed_skills.includes(skill)) throw new BlueprintRejected("skill_not_in_contract", "resolved_skills");
  }
  return skills;
}

/**
 * Derive the execution graph. Reads ONLY: runtime.agent, runtime.installation, delivery.mode,
 * delivery.channels, integrations[].id/skill/access, automations[].id/enabled, policies.*,
 * resolved_skills. Throws BlueprintRejected (blocked_reason invalid_blueprint) on any structural mismatch.
 */
export function deriveExecutionGraph(blueprint, contract, operator) {
  try {
    return deriveGraphUnchecked(blueprint, contract, operator);
  } catch (error) {
    // A structurally malformed blueprint (missing object, wrong type) is rejected, not crashed on.
    // Only native TypeErrors are converted; anything else (including a test's throwing getter) propagates.
    if (error instanceof TypeError) throw new BlueprintRejected("malformed_structure", "blueprint");
    throw error;
  }
}

function deriveGraphUnchecked(blueprint, contract, operator) {
  const input = validateOperatorInput(contract, operator);
  const plan = contract.plan_source;

  const runtime = blueprint.runtime;
  const agent = runtime.agent;
  const installation = runtime.installation;
  expectEqual(agent, contract.runtime.name, "runtime.agent");
  expectEqual(installation, plan.expected_installation, "runtime.installation");

  const delivery = blueprint.delivery;
  const mode = delivery.mode;
  const channels = expectList(delivery.channels, "delivery.channels");
  expectEqual(mode, "platforms", "delivery.mode");
  if (channels.length !== plan.delivery_ids.length || channels.some((id, index) => id !== plan.delivery_ids[index])) {
    throw new BlueprintRejected("unexpected_value", "delivery.channels");
  }

  const rawIntegrations = expectList(blueprint.integrations, "integrations");
  if (rawIntegrations.length !== plan.source_ids.length) throw new BlueprintRejected("unexpected_value", "integrations");
  const integrations = rawIntegrations.map((item, index) => {
    const id = item.id;
    const skill = item.skill;
    const access = item.access;
    expectEqual(id, plan.source_ids[index], "integrations[].id");
    expectEqual(skill, contract.adapters.github.skill, "integrations[].skill");
    expectEqual(access, contract.adapters.github.access, "integrations[].access");
    return { id, skill, access };
  });

  const rawAutomations = expectList(blueprint.automations, "automations");
  if (rawAutomations.length !== 1) throw new BlueprintRejected("unexpected_value", "automations");
  const automations = rawAutomations.map((item) => {
    const id = item.id;
    const enabled = item.enabled;
    expectEqual(id, plan.expected_automation_id, "automations[].id");
    expectEqual(enabled, true, "automations[].enabled");
    return { id, enabled };
  });

  const policy = blueprint.policies;
  const policies = {
    destructive_actions: policy.destructive_actions,
    external_messages: policy.external_messages,
    safe_operations: policy.safe_operations,
  };
  for (const [key, value] of Object.entries(policies)) {
    expectEqual(value, plan.expected_policy, `policies.${key}`);
  }

  const claimed = expectList(blueprint.resolved_skills, "resolved_skills");
  const skills = deriveSkills(contract, channels, automations.length);
  if (claimed.length !== skills.length || claimed.some((skill, index) => skill !== skills[index])) {
    throw new BlueprintRejected("resolved_skills_mismatch", "resolved_skills");
  }

  return {
    graph_version: 1,
    recipe: contract.recipe,
    contract_hash: contractHash(contract),
    runtime: { agent, installation },
    delivery: { mode, channels },
    integrations,
    automations,
    policies,
    skills,
    managed_env_keys: [...contract.managed_env_keys],
    managed_skills: [...skills],
    destination: {
      platform: contract.destination.platform,
      env_key: contract.destination.env_key,
      fingerprint: input.destinationFingerprint,
    },
    schedule: {
      id: contract.schedule.id,
      cron: input.schedule,
      prompt_sha256: sha256Hex(contract.schedule.prompt),
    },
  };
}

export function planHash(graph) {
  return canonicalHash(graph);
}

const BIDI_AND_INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const ANSI_SEQUENCE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-Z\\-_])/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;

/** One line of text with ANSI sequences, control characters and bidi/zero-width characters removed and whitespace collapsed. */
export function sanitizeLine(value) {
  const text = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  return text.replace(ANSI_SEQUENCE, " ").replace(BIDI_AND_INVISIBLE, "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
}

export const UNTRUSTED_PREFIX = "[untrusted blueprint text] ";
export const UNTRUSTED_MAX_LENGTH = 280;

/** Make untrusted text safe to show in a terminal or log: strip ANSI/control/bidi, collapse whitespace, cap length. */
export function renderUntrustedText(value) {
  let text = sanitizeLine(value);
  if (text.length > UNTRUSTED_MAX_LENGTH) text = `${text.slice(0, UNTRUSTED_MAX_LENGTH - 1)}\u2026`;
  return `${UNTRUSTED_PREFIX}${text}`;
}

/** Display-only summary of a blueprint for humans. This is the ONLY function that reads display fields. */
export function describeBlueprintForDisplay(blueprint) {
  return {
    name: renderUntrustedText(blueprint?.name),
    description: renderUntrustedText(blueprint?.description),
  };
}
