#!/usr/bin/env python3
"""Validate a declarative hstack/Hermes blueprint without executing it.

The validator intentionally accepts JSON only. JSON keeps the plan reviewable while
avoiding an extra YAML parser and, more importantly, prevents a blueprint from being
mistaken for executable installer input. The installer re-derives the skill order from
the safe fields below; `resolved_skills` is a checked review artifact, never authority.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Sequence, Tuple

SCHEMA_VERSION = 1

CHANNELS: Dict[str, str] = {
    "telegram": "platform-telegram",
    "slack": "platform-slack",
    "discord": "platform-discord",
}

INTEGRATIONS: Dict[str, Tuple[str, Sequence[str]]] = {
    "asana": ("integration-asana", ("read_only", "read_write")),
    "aws": ("integration-aws", ("read_only", "read_write")),
    "azure": ("integration-azure", ("read_only", "read_write")),
    "calendly": ("integration-calendly", ("read_only",)),
    "clickup": ("integration-clickup", ("read_only", "read_write")),
    "datadog": ("integration-datadog", ("read_only",)),
    "gcp": ("integration-gcp", ("read_only", "read_write")),
    "github": ("integration-github", ("read_only", "read_write")),
    "google-workspace": ("integration-google-workspace", ("read_only", "read_write")),
    "hubspot": ("integration-hubspot", ("read_only", "read_write")),
    "linear": ("integration-linear", ("read_only", "read_write")),
    "mem0": ("integration-mem0", ("read_only", "read_write")),
    "notion": ("integration-notion", ("read_only", "read_write")),
    "posthog": ("integration-posthog", ("read_only",)),
    "postgres": ("integration-postgres", ("read_only", "read_write")),
    "railway": ("integration-railway", ("read_only", "read_write")),
    "redis": ("integration-redis", ("read_only", "read_write")),
    "render": ("integration-render", ("read_only", "read_write")),
    "sentry": ("integration-sentry", ("read_only",)),
    "stripe": ("integration-stripe", ("read_only", "read_write")),
    "vercel": ("integration-vercel", ("read_only", "read_write")),
    "zoom": ("integration-zoom", ("read_only",)),
}

AUTOMATIONS = {
    "critical-error-alerts",
    "daily-agenda",
    "daily-health-check",
    "deployment-summary",
    "follow-up-reminders",
    "incident-alerts",
    "meeting-preparation",
    "morning-briefing",
    "post-incident-report",
    "revenue-change-alerts",
    "weekly-founder-review",
    "weekly-priorities",
}

SOURCE_BLUEPRINTS = {"saas-founder", "chief-of-staff", "devops-oncall"}
ROOT_KEYS = {
    "schema_version",
    "name",
    "description",
    "source_blueprints",
    "runtime",
    "delivery",
    "integrations",
    "automations",
    "behaviors",
    "policies",
    "credential_requirements",
    "resolved_skills",
}
FORBIDDEN_KEYS = {"args", "arguments", "command", "commands", "password", "secret", "secrets", "token", "tokens", "url", "urls"}
SECRET_PATTERNS = (
    re.compile(r"\b(?:sk_live|sk-proj|ghp|xoxb)-?[A-Za-z0-9_-]{16,}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bAIza[0-9A-Za-z_-]{28,}\b"),
)
NAME_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def no_duplicate_object(pairs: Iterable[Tuple[str, Any]]) -> Dict[str, Any]:
    result: Dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def read_plan(path: Path) -> Dict[str, Any]:
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as error:
        raise ValueError(f"cannot read plan: {error}") from error
    try:
        value = json.loads(raw, object_pairs_hook=no_duplicate_object)
    except (json.JSONDecodeError, ValueError) as error:
        raise ValueError(f"plan must be valid JSON: {error}") from error
    if not isinstance(value, dict):
        raise ValueError("plan root must be a JSON object")
    return value


def add_type_error(errors: List[str], path: str, expected: str) -> None:
    errors.append(f"{path} must be {expected}")


def require_object(value: Any, path: str, errors: List[str]) -> Dict[str, Any]:
    if not isinstance(value, dict):
        add_type_error(errors, path, "an object")
        return {}
    return value


def require_list(value: Any, path: str, errors: List[str]) -> List[Any]:
    if not isinstance(value, list):
        add_type_error(errors, path, "an array")
        return []
    return value


def ensure_only_keys(value: Dict[str, Any], allowed: set[str], path: str, errors: List[str]) -> None:
    for key in value:
        if key not in allowed:
            errors.append(f"{path}.{key} is not allowed")


def ensure_no_secrets(value: Any, path: str, errors: List[str]) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if key.lower() in FORBIDDEN_KEYS:
                errors.append(f"{path}.{key} is not allowed in a blueprint")
            ensure_no_secrets(child, f"{path}.{key}", errors)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            ensure_no_secrets(child, f"{path}[{index}]", errors)
    elif isinstance(value, str):
        for pattern in SECRET_PATTERNS:
            if pattern.search(value):
                errors.append(f"{path} appears to contain a credential")
                break


def unique_strings(values: List[Any], path: str, errors: List[str]) -> List[str]:
    result: List[str] = []
    seen = set()
    for index, value in enumerate(values):
        if not isinstance(value, str):
            add_type_error(errors, f"{path}[{index}]", "a string")
            continue
        if value in seen:
            errors.append(f"{path} contains duplicate value '{value}'")
            continue
        seen.add(value)
        result.append(value)
    return result


def derive_skills(plan: Dict[str, Any]) -> List[str]:
    """Resolve the exact safe skill order from declarative data."""
    runtime = plan["runtime"]
    channels = plan["delivery"]["channels"]
    integrations = plan["integrations"]
    behaviors = plan["behaviors"]
    automations = plan["automations"]
    skills: List[str] = []
    if runtime["installation"] == "deploy_if_missing":
        skills.append("hermes-deploy")
        channel_ids = channels[1:]
    else:
        channel_ids = channels
    skills.extend(CHANNELS[channel] for channel in channel_ids)
    skills.extend(INTEGRATIONS[item["id"]][0] for item in integrations)
    if channels:
        skills.append("hermes-home")
    if behaviors["automatic_backups"]:
        skills.append("hermes-backup")
    if automations:
        skills.append("hermes-cron")
    ordered: List[str] = []
    for skill in skills:
        if skill not in ordered:
            ordered.append(skill)
    return ordered


def validate(plan: Dict[str, Any]) -> Tuple[List[str], List[str]]:
    errors: List[str] = []
    ensure_only_keys(plan, ROOT_KEYS, "plan", errors)
    ensure_no_secrets(plan, "plan", errors)

    if plan.get("schema_version") != SCHEMA_VERSION:
        errors.append(f"schema_version must equal {SCHEMA_VERSION}")

    name = plan.get("name")
    if not isinstance(name, str) or not NAME_PATTERN.fullmatch(name):
        errors.append("name must be lowercase kebab-case")
    if len(str(name or "")) > 64:
        errors.append("name must be 64 characters or fewer")

    description = plan.get("description")
    if not isinstance(description, str) or not description.strip():
        errors.append("description must be a non-empty string")
    elif len(description) > 500:
        errors.append("description must be 500 characters or fewer")

    source = unique_strings(require_list(plan.get("source_blueprints"), "source_blueprints", errors), "source_blueprints", errors)
    for blueprint in source:
        if blueprint not in SOURCE_BLUEPRINTS:
            errors.append(f"source_blueprints contains unknown blueprint '{blueprint}'")

    runtime = require_object(plan.get("runtime"), "runtime", errors)
    ensure_only_keys(runtime, {"agent", "installation"}, "runtime", errors)
    if runtime.get("agent") != "hermes":
        errors.append("runtime.agent must be 'hermes'")
    if runtime.get("installation") not in {"existing_agent", "deploy_if_missing"}:
        errors.append("runtime.installation must be existing_agent or deploy_if_missing")

    delivery = require_object(plan.get("delivery"), "delivery", errors)
    ensure_only_keys(delivery, {"mode", "channels"}, "delivery", errors)
    channels = unique_strings(require_list(delivery.get("channels"), "delivery.channels", errors), "delivery.channels", errors)
    for channel in channels:
        if channel not in CHANNELS:
            errors.append(f"delivery.channels contains unknown channel '{channel}'")
    expected_mode = "platforms" if channels else "terminal"
    if delivery.get("mode") != expected_mode:
        errors.append(f"delivery.mode must be '{expected_mode}' for the selected channels")
    if runtime.get("installation") == "deploy_if_missing" and not channels:
        errors.append("deploy_if_missing requires at least one delivery channel")

    raw_integrations = require_list(plan.get("integrations"), "integrations", errors)
    integrations: List[Dict[str, Any]] = []
    integration_ids = set()
    for index, raw in enumerate(raw_integrations):
        item = require_object(raw, f"integrations[{index}]", errors)
        ensure_only_keys(item, {"id", "skill", "access"}, f"integrations[{index}]", errors)
        integration_id = item.get("id")
        if not isinstance(integration_id, str) or integration_id not in INTEGRATIONS:
            errors.append(f"integrations[{index}].id must name a supported integration")
            continue
        if integration_id in integration_ids:
            errors.append(f"integrations contains duplicate id '{integration_id}'")
            continue
        integration_ids.add(integration_id)
        expected_skill, access_modes = INTEGRATIONS[integration_id]
        if item.get("skill") != expected_skill:
            errors.append(f"integrations[{index}].skill must be '{expected_skill}'")
        if item.get("access") not in access_modes:
            errors.append(f"integrations[{index}].access is not supported for '{integration_id}'")
        integrations.append(item)

    behaviors = require_object(plan.get("behaviors"), "behaviors", errors)
    ensure_only_keys(behaviors, {"long_term_memory", "automatic_backups"}, "behaviors", errors)
    for key in ("long_term_memory", "automatic_backups"):
        if not isinstance(behaviors.get(key), bool):
            errors.append(f"behaviors.{key} must be true or false")
    if behaviors.get("long_term_memory") and "mem0" not in integration_ids:
        errors.append("long_term_memory requires the supported mem0 integration")

    raw_automations = require_list(plan.get("automations"), "automations", errors)
    automations: List[Dict[str, Any]] = []
    automation_ids = set()
    for index, raw in enumerate(raw_automations):
        item = require_object(raw, f"automations[{index}]", errors)
        ensure_only_keys(item, {"id", "enabled", "cadence"}, f"automations[{index}]", errors)
        automation_id = item.get("id")
        if not isinstance(automation_id, str) or automation_id not in AUTOMATIONS:
            errors.append(f"automations[{index}].id must name a supported automation")
            continue
        if automation_id in automation_ids:
            errors.append(f"automations contains duplicate id '{automation_id}'")
            continue
        automation_ids.add(automation_id)
        if item.get("enabled") is not True:
            errors.append(f"automations[{index}].enabled must be true")
        if not isinstance(item.get("cadence"), str) or not item["cadence"].strip():
            errors.append(f"automations[{index}].cadence must be a non-empty string")
        automations.append(item)
    if automations and not channels:
        errors.append("automations require a delivery channel; terminal-only plans are manual-only")

    policies = require_object(plan.get("policies"), "policies", errors)
    ensure_only_keys(policies, {"external_messages", "destructive_actions", "safe_operations"}, "policies", errors)
    if policies.get("external_messages") != "approval_required":
        errors.append("policies.external_messages must be approval_required")
    if policies.get("destructive_actions") != "approval_required":
        errors.append("policies.destructive_actions must be approval_required")
    if policies.get("safe_operations") not in {"approval_required", "automatic"}:
        errors.append("policies.safe_operations must be approval_required or automatic")

    requirements = require_list(plan.get("credential_requirements"), "credential_requirements", errors)
    for index, raw in enumerate(requirements):
        item = require_object(raw, f"credential_requirements[{index}]", errors)
        ensure_only_keys(item, {"service", "credential", "recommended_scope"}, f"credential_requirements[{index}]", errors)
        for key in ("service", "credential", "recommended_scope"):
            if not isinstance(item.get(key), str) or not item[key].strip():
                errors.append(f"credential_requirements[{index}].{key} must be a non-empty string")

    resolved = unique_strings(require_list(plan.get("resolved_skills"), "resolved_skills", errors), "resolved_skills", errors)
    if not errors:
        derived = derive_skills(plan)
        if resolved != derived:
            errors.append("resolved_skills does not match the skill order derived from the approved plan fields")
    else:
        derived = []
    return errors, derived


def print_summary(plan: Dict[str, Any], skills: List[str]) -> None:
    delivery = plan["delivery"]
    print(f"Blueprint: {plan['name']}")
    print(f"Runtime: {plan['runtime']['installation']}")
    print("Delivery: " + (", ".join(delivery["channels"]) if delivery["channels"] else "terminal only"))
    print("Integrations: " + (", ".join(item["id"] for item in plan["integrations"]) or "none"))
    print("Automations: " + (", ".join(item["id"] for item in plan["automations"]) or "none"))
    print("Resolved skills:")
    for skill in skills:
        print(f"  - /{skill}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("plan", type=Path, help="path to a .hstack-blueprint.json file")
    parser.add_argument("--json", action="store_true", help="emit normalized validation data as JSON")
    parser.add_argument("--summary", action="store_true", help="print a human-readable plan summary")
    args = parser.parse_args()
    try:
        plan = read_plan(args.plan)
    except ValueError as error:
        print(f"INVALID: {error}", file=sys.stderr)
        return 1
    errors, skills = validate(plan)
    if errors:
        print("INVALID BLUEPRINT:", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps({"valid": True, "name": plan["name"], "resolved_skills": skills}, indent=2))
    elif args.summary:
        print_summary(plan, skills)
    else:
        print(f"VALID: {plan['name']} ({len(skills)} resolved skills)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
