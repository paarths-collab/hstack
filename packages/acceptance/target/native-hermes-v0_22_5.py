"""Narrow, candidate-only Hermes v0.22.5 cron adapter.

Reads the tagged release's canonical cron/jobs.json without importing Hermes (its
reader creates directories and repairs storage). Every live change uses the public
CLI, explicitly bound to the default profile. This module never writes jobs.json.
Source: https://github.com/NousResearch/hermes-agent/blob/v0.22.5/cron/jobs.py
CLI: https://github.com/NousResearch/hermes-agent/blob/v0.22.5/hermes_cli/subcommands/cron.py
The shell artifact embeds these bytes; there is no mutable sidecar in production.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import time

READINESS_RETRY_SECONDS = 3
VERSION = "0.22.5"
COMMIT = "bf0203a794a07aac3ff764972ab9087baa4e4f4e"
FORMAT = "hstack-native-cron-v1"
BEFORE = "native-cron.before.json"
PLAN = "native-cron.plan.json"
MAX_BYTES = 16 * 1024 * 1024
SKILLS = ["platform-telegram", "integration-github", "hermes-home", "hermes-cron"]
ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
MANAGED_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
MARKER = re.compile(r"\[hstack:([a-z0-9][a-z0-9-]{0,63})\]")
# Scheduler progress is deliberately not an operator configuration change. Keep
# every other field in signatures, including unknown future fields (fail closed).
PROGRESS = {
    "created_at", "updated_at", "next_run_at", "last_run_at", "last_status", "last_error",
    "last_delivery_error", "last_delivery_unverified", "last_delivery_queued", "last_failure",
    "failure_streak", "last_dispatch", "last_fire_error", "latest_execution", "fire_claim",
    "run_claim", "paused_at", "monitor_state", "quota_hold", "quota_hold_until",
    # Tagged cron.jobs trigger/dispatch/completion and retry bookkeeping. These
    # are persisted by an ordinary run, not operator configuration. In particular,
    # canonical_completions survives a successful delivery; comparing it as config
    # would make the first real run unverifiable and block later recovery.
    "canonical_completions", "manual_run_at", "manual_run_prompt", "pending_slot",
    "preflight_alerted", "unreachable_retry", "quota_hold_cron_expr",
}
FIELDS = {
    "name", "prompt", "schedule", "skills", "model", "provider", "base_url", "script",
    "no_agent", "monitor_script", "monitor_url", "context_from", "enabled_toolsets", "workdir",
    "repeat", "enabled", "paused_reason", "deliver", "origin", "attach_to_session",
    "reasoning_effort", "failure_deliver", "interpreter",
}


class Refusal(Exception):
    def __init__(self, code, detail="native_cron_refused", status=4):
        self.code, self.detail, self.status = code, detail, status


def refuse(code, detail="native_cron_refused", status=4):
    raise Refusal(code, detail, status)


def output(**fields):
    for key, value in fields.items():
        print("{}={}".format(key, value))


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            refuse("native_cron_store_invalid", "duplicate_json_key")
        result[key] = value
    return result


def strict_read(file, missing=None):
    try:
        # A FIFO blocks in open() before fstat can reject it. Nonblocking open
        # permits the descriptor type check without waiting for a writer.
        fd = os.open(str(file), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    except FileNotFoundError:
        return missing
    except OSError:
        refuse("native_cron_store_invalid", "unsafe_or_unreadable_file")
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_BYTES:
            refuse("native_cron_store_invalid", "invalid_file_type_or_size")
        with os.fdopen(fd, "rb") as handle:
            fd = None
            raw = handle.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            refuse("native_cron_store_invalid", "invalid_file_size")
        return json.loads(raw.decode("utf-8"), object_pairs_hook=unique_pairs,
                          parse_constant=lambda _: refuse("native_cron_store_invalid", "nonfinite_json"))
    except (UnicodeError, ValueError, RecursionError):
        refuse("native_cron_store_invalid", "invalid_json")
    finally:
        if fd is not None:
            os.close(fd)


def directory(path, optional=False):
    try:
        info = path.lstat()
    except FileNotFoundError:
        if optional:
            return False
        refuse("native_cron_path_invalid", "missing_directory")
    if not stat.S_ISDIR(info.st_mode):
        refuse("native_cron_path_invalid", "unsafe_directory")
    return True


def atomic_private(file, data):
    if file.is_symlink():
        refuse("native_cron_path_invalid", "unsafe_snapshot")
    fd, temp = tempfile.mkstemp(prefix=".native-cron-", dir=str(file.parent))
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(canonical(data) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, file)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def managed_id(job):
    markers = MARKER.findall(job["prompt"])
    if len(markers) > 1 or ("[hstack:" in job["prompt"] and len(markers) != 1):
        refuse("native_cron_store_invalid", "ambiguous_ownership_marker")
    return markers[0] if markers else None


def projection(job):
    if not isinstance(job, dict) or not isinstance(job.get("id"), str) or not ID.fullmatch(job["id"]):
        refuse("native_cron_store_invalid", "invalid_job_identity")
    if not isinstance(job.get("prompt"), str) or not isinstance(job.get("schedule"), dict):
        refuse("native_cron_store_invalid", "invalid_job_configuration")
    projected = {key: value for key, value in job.items() if key not in PROGRESS | {"id", "skill", "schedule_display", "state"}}
    # Upstream keeps an alias for the first attached skill; normalize only that
    # documented alias, not arbitrary missing or invalid operator configuration.
    projected["skills"] = job.get("skills") or ([job["skill"]] if job.get("skill") else [])
    projected["schedule"] = {key: value for key, value in job["schedule"].items() if key != "display"}
    repeat = job.get("repeat")
    if not isinstance(repeat, dict) or set(repeat) - {"times", "completed"}:
        refuse("native_cron_store_invalid", "invalid_repeat_configuration")
    projected["repeat"] = {"times": repeat.get("times")}
    for key in ("model", "provider", "base_url", "script", "monitor_script", "monitor_url", "context_from",
                "enabled_toolsets", "workdir", "paused_reason", "origin", "attach_to_session",
                "reasoning_effort", "failure_deliver", "interpreter"):
        projected.setdefault(key, None)
    projected.setdefault("no_agent", False)
    projected.setdefault("enabled", True)
    projected.setdefault("deliver", "local")
    if type(projected["enabled"]) is not bool:
        refuse("native_cron_store_invalid", "invalid_enabled_state")
    # Terminal/unknown state for a managed job is not equivalent to a scheduled
    # job and cannot be reconstructed by create; never silently reactivate it.
    if managed_id(job):
        expected_state = "scheduled" if projected["enabled"] else "paused"
        # is_job_runnable uses both enabled and pause markers. The CLI's display
        # state alone is insufficient: recreating a half-paused record activates it.
        if job.get("state", expected_state) != expected_state or (projected["enabled"] and job.get("paused_at")):
            refuse("native_cron_configuration_unsupported", "managed_job_state")
    return projected


def restorable(config):
    if not isinstance(config, dict) or set(config) != FIELDS:
        refuse("native_cron_configuration_unsupported", "managed_job_fields")
    schedule = config["schedule"]
    if not isinstance(schedule, dict) or set(schedule) != {"kind", "expr"} or schedule["kind"] != "cron":
        refuse("native_cron_configuration_unsupported", "managed_job_schedule")
    if valid_schedule(schedule["expr"]) != schedule["expr"]:
        refuse("native_cron_configuration_unsupported", "managed_job_schedule")
    for key in ("base_url", "script", "monitor_script", "monitor_url", "context_from", "enabled_toolsets",
                "workdir", "origin", "attach_to_session", "interpreter"):
        if config[key] is not None:
            refuse("native_cron_configuration_unsupported", "managed_job_option")
    if config["repeat"] != {"times": None} or config["no_agent"] is not False:
        refuse("native_cron_configuration_unsupported", "managed_job_mode")
    if (not isinstance(config["name"], str) or not config["name"] or len(config["name"]) > 256 or "\0" in config["name"]
            or not isinstance(config["prompt"], str) or len(config["prompt"]) > 1000 or "\0" in config["prompt"]
            or config["prompt"] != config["prompt"].strip()):
        refuse("native_cron_configuration_unsupported", "managed_job_text")
    if not isinstance(config["deliver"], str) or not re.fullmatch(r"[A-Za-z0-9_:,.-]{1,256}", config["deliver"]):
        refuse("native_cron_configuration_unsupported", "managed_job_delivery")
    if not isinstance(config["skills"], list) or any(not isinstance(x, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,127}", x) for x in config["skills"]):
        refuse("native_cron_configuration_unsupported", "managed_job_skills")
    if len(set(config["skills"])) != len(config["skills"]):
        refuse("native_cron_configuration_unsupported", "managed_job_skills")
    for key in ("model", "provider", "reasoning_effort", "failure_deliver"):
        if config[key] is not None and (not isinstance(config[key], str) or not config[key] or len(config[key]) > 256
                                        or "\0" in config[key] or config[key] != config[key].strip()):
            refuse("native_cron_configuration_unsupported", "managed_job_option")
    if config["reasoning_effort"] is not None and config["reasoning_effort"] not in {"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"}:
        refuse("native_cron_configuration_unsupported", "managed_job_option")
    if config["enabled"] and config["paused_reason"] is not None:
        refuse("native_cron_configuration_unsupported", "managed_job_pause")
    if not config["enabled"] and (not isinstance(config["paused_reason"], str) or not config["paused_reason"]
                                  or config["paused_reason"] != config["paused_reason"].strip() or "\0" in config["paused_reason"]):
        refuse("native_cron_configuration_unsupported", "managed_job_pause")


def valid_schedule(value):
    if not isinstance(value, str) or len(value) > 64 or not re.fullmatch(r"[0-9*/, -]+", value) or len(value.split()) != 5:
        refuse("native_cron_configuration_unsupported", "managed_job_schedule")
    fields = value.split()
    # A lexical five-field check accepts impossible schedules (e.g. minute 99)
    # and creates a transaction that can only fail later inside native croniter.
    # Keep this narrow numeric grammar aligned with the reviewed recipe boundary.
    for field, (low, high) in zip(fields, ((0, 59), (0, 23), (1, 31), (1, 12), (0, 7))):
        for item in field.split(","):
            matched = re.fullmatch(r"(\*|[0-9]+(?:-[0-9]+)?)(?:/([0-9]+))?", item)
            if not matched or (matched.group(2) is not None and int(matched.group(2)) < 1):
                refuse("native_cron_configuration_unsupported", "managed_job_schedule")
            base = matched.group(1)
            if base != "*":
                bounds = [int(number) for number in base.split("-")]
                if any(number < low or number > high for number in bounds) or bounds[0] > bounds[-1]:
                    refuse("native_cron_configuration_unsupported", "managed_job_schedule")
    return " ".join(fields)


def desired(identifier, schedule, prompt):
    if not MANAGED_ID.fullmatch(identifier) or not isinstance(prompt, str) or len(prompt) > 400 or not re.fullmatch(r"[A-Za-z0-9 _.,:=+@%/*\[\]-]+", prompt):
        refuse("native_cron_configuration_unsupported", "invalid_plan")
    marker = "[hstack:{}]".format(identifier)
    if MARKER.findall(prompt) != [identifier]:
        refuse("native_cron_configuration_unsupported", "invalid_plan_marker")
    config = dict.fromkeys(FIELDS)
    config.update(name=marker, prompt=prompt, schedule={"kind": "cron", "expr": valid_schedule(schedule)},
                  skills=SKILLS, no_agent=False, repeat={"times": None}, enabled=True, deliver="telegram")
    restorable(config)
    return config


class Adapter:
    def __init__(self, home, hermes):
        self.home = Path(home)
        if not self.home.is_absolute() or self.home.name != ".hermes" or "/profiles/" in str(self.home):
            refuse("native_cron_path_invalid", "default_profile_required")
        directory(self.home)
        self.home = self.home.resolve()
        self.hermes = str(hermes)
        if not os.path.isabs(self.hermes):
            refuse("native_cron_path_invalid", "absolute_hermes_required")

    def jobs(self):
        cron = self.home / "cron"
        if not directory(cron, optional=True):
            return []
        payload = strict_read(cron / "jobs.json", missing={"jobs": []})
        if not isinstance(payload, dict) or set(payload) - {"jobs", "updated_at"} or not isinstance(payload.get("jobs"), list):
            refuse("native_cron_store_invalid", "unsupported_store_shape")
        result, ids = [], set()
        for raw in payload["jobs"]:
            config = projection(raw)
            if raw["id"] in ids:
                refuse("native_cron_store_invalid", "duplicate_job_id")
            ids.add(raw["id"])
            result.append({"id": raw["id"], "managed_id": managed_id(raw), "config": config})
        return sorted(result, key=lambda item: item["id"])

    def txn(self, value, backup=False):
        txn = Path(value)
        valid_name = re.fullmatch(r"[a-z0-9]{8,32}", txn.name) or (backup and re.fullmatch(r"\.tmp\.[a-z0-9]{8,32}\.[0-9]+", txn.name))
        parent = self.home / ".hstack" / "txn"
        if not valid_name or not txn.is_absolute() or txn.parent.resolve() != parent:
            refuse("native_cron_path_invalid", "invalid_transaction_path")
        directory(self.home / ".hstack")
        directory(parent)
        txn = parent / txn.name
        directory(txn)
        return txn

    def before(self, txn):
        data = strict_read(txn / BEFORE)
        if not isinstance(data, dict) or set(data) != {"format", "version", "home", "jobs"} or data["format"] != FORMAT or data["version"] != VERSION or data["home"] != str(self.home) or not isinstance(data["jobs"], list):
            refuse("native_cron_snapshot_invalid", "invalid_snapshot")
        # Private snapshots are integrity-protected by the outer transaction;
        # also validate their semantic shape before constructing any CLI argv.
        for item in data["jobs"]:
            if not isinstance(item, dict) or set(item) != {"id", "managed_id", "config"} or not isinstance(item["id"], str) or not ID.fullmatch(item["id"]):
                refuse("native_cron_snapshot_invalid", "invalid_snapshot")
            if item["managed_id"] is not None:
                if not isinstance(item["managed_id"], str) or not MANAGED_ID.fullmatch(item["managed_id"]):
                    refuse("native_cron_snapshot_invalid", "invalid_snapshot")
                restorable(item["config"])
        return data["jobs"]

    def plan(self, txn):
        plan = strict_read(txn / PLAN, missing={"format": FORMAT, "jobs": {}})
        if not isinstance(plan, dict) or set(plan) != {"format", "jobs"} or plan["format"] != FORMAT or not isinstance(plan["jobs"], dict):
            refuse("native_cron_snapshot_invalid", "invalid_plan")
        for identifier, spec in plan["jobs"].items():
            if not isinstance(spec, dict) or set(spec) != {"schedule", "prompt", "config"} or spec["config"] != desired(identifier, spec["schedule"], spec["prompt"]):
                refuse("native_cron_snapshot_invalid", "invalid_plan")
        return plan

    @staticmethod
    def configurations(jobs, identifier):
        return sorted([item["config"] for item in jobs if item["managed_id"] == identifier], key=canonical)

    @staticmethod
    def unrelated(jobs, identifiers):
        return [item for item in jobs if item["managed_id"] not in identifiers]

    def check(self, before, current, plan):
        identifiers = set(plan["jobs"])
        if self.unrelated(before, identifiers) != self.unrelated(current, identifiers):
            refuse("native_cron_conflict", "unrelated_configuration_changed", 3)
        for identifier, spec in plan["jobs"].items():
            prior = self.configurations(before, identifier)
            permitted = [canonical(config) for config in prior] + [canonical(spec["config"])]
            if any(canonical(config) not in permitted for config in self.configurations(current, identifier)):
                refuse("native_cron_conflict", "managed_configuration_changed", 3)

    def run(self, args):
        env = self.environment()
        # An explicit selector wins over Hermes' sticky active_profile setting.
        result = subprocess.run([self.hermes, "--profile", "default", "cron"] + args, env=env,
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                timeout=120, check=False)
        if result.returncode != 0:
            refuse("native_cron_cli_failed", "native_cli_outcome_unconfirmed", 1)

    def environment(self):
        env = {key: value for key, value in os.environ.items()
               if not key.startswith("HERMES_SESSION_") and key != "HERMES_CRON_SESSION"}
        env.update(HERMES_HOME=str(self.home), HERMES_PROFILE="default", HERMES_PROFILE_NAME="default")
        return env

    def service_check(self):
        # v0.22.5 profiles._iter_named_profile_dirs discovers profiles in this
        # directory, including symlinks to external homes. Refuse every entry,
        # including unknown/ghost layouts, rather than guessing who is served.
        profiles = self.home / "profiles"
        if directory(profiles, optional=True) and any(profiles.iterdir()):
            refuse("native_gateway_scope_unsupported", "exclusive_default_profile_required")
        state = strict_read(self.home / "gateway_state.json")
        if state is not None:
            if not isinstance(state, dict) or not isinstance(state.get("served_profiles"), list):
                refuse("native_gateway_scope_unsupported", "unknown_profile_registry")
            if any(not isinstance(name, str) or name != "default" for name in state["served_profiles"]):
                refuse("native_gateway_scope_unsupported", "exclusive_default_profile_required")

    def _ensure(self, prefix, env, seconds):
        """Run `gateway ensure --json`; returns (exit code, parsed JSON or None)."""
        result = subprocess.run(prefix + ["ensure", "--json", "--timeout", str(seconds)], env=env,
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                timeout=seconds + 10, check=False)
        if len(result.stdout) > 65536:
            return result.returncode, None
        try:
            return result.returncode, json.loads(result.stdout.decode("utf-8"), object_pairs_hook=unique_pairs)
        except (UnicodeError, ValueError):
            return result.returncode, None

    def reload(self, interrupt_live_sessions=False):
        """Restart the default-profile gateway and prove a NEW, ready instance came up.

        1. remember the current instance_id (`gateway ensure --json --timeout 10`, if a gateway answers);
        2. `gateway restart --detach`, plus `-y` ONLY when the operator opted in to interrupting live sessions;
        3. `gateway ensure --json --timeout 60` must exit 0 with state "ready" (exit 5/6 is transient: retried twice),
           match this release and home, and carry an instance_id different from step 1.
        v0.22.5: hermes_cli/subcommands/gateway.py:146-155 (restart parser: -y/--yes/--interrupt, --detach);
        hermes_cli/gateway.py _cmd_restart 5454-5540 restarts a systemd service through its manager. Without -y and
        without a TTY it REFUSES with exit 1 while sessions are live (gateway_lifecycle_guards.py:97-132), which
        is reported, never forced. --detach only matters without an installed service, where the replacement would
        otherwise run in the foreground of this call (gateway_supervised_restart.py:140-151). `restart` can exit 0
        without restarting at all (a linger warning returns normally, gateway.py:5499-5513); instance_id is a
        fresh uuid4 per gateway process (gateway/run_runtime.py:144), so an unchanged id means nothing restarted.
        `gateway run --daemon` does not exist.
        """
        self.service_check()
        env = self.environment()
        prefix = [self.hermes, "--profile", "default", "gateway"]
        previous = None
        try:
            code, before = self._ensure(prefix, env, 10)
        except (OSError, subprocess.SubprocessError):
            code, before = 1, None
        # A draining verdict (exit 6) can still identify the serving process.
        # Keep that identity: an exit-0 restart can be a no-op after a linger warning.
        if code in (0, 6) and isinstance(before, dict) and isinstance(before.get("endpoint"), dict):
            endpoint = before["endpoint"]
            candidate = endpoint.get("instance_id")
            if (before.get("state") == ("ready" if code == 0 else "draining")
                    and endpoint.get("profile_id") == str(self.home)
                    and endpoint.get("control_home") in {None, str(self.home)}
                    and endpoint.get("code_sha") == COMMIT and before.get("client_code_sha") == COMMIT):
                previous = candidate if isinstance(candidate, str) and candidate else None
        if previous is None:
            refuse("native_gateway_reload_failed", "native_previous_instance_unconfirmed", 1)
        self.service_check()
        argv = prefix + ["restart"] + (["-y"] if interrupt_live_sessions else []) + ["--detach"]
        try:
            result = subprocess.run(argv, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL, timeout=120, check=False)
        except (OSError, subprocess.SubprocessError):
            refuse("native_gateway_reload_failed", "native_restart_unconfirmed", 1)
        if result.returncode != 0:
            # Typically live sessions without an interrupt opt-in; the opt-in is the operator's decision.
            refuse("native_gateway_reload_failed", "native_restart_refused_or_failed", 1)
        attempts = 0
        while True:
            attempts += 1
            try:
                code, ready = self._ensure(prefix, env, 60)
            except (OSError, subprocess.SubprocessError):
                refuse("native_gateway_reload_failed", "native_readiness_unconfirmed", 1)
            if code in (5, 6) and attempts < 3:  # deadline / draining: transient
                time.sleep(READINESS_RETRY_SECONDS)
                continue
            break
        if code != 0 or ready is None:
            refuse("native_gateway_reload_failed", "native_readiness_unconfirmed", 1)
        endpoint = ready.get("endpoint") if isinstance(ready, dict) else None
        if (not isinstance(endpoint, dict) or ready.get("state") != "ready"
                or endpoint.get("profile_id") != str(self.home)
                or endpoint.get("control_home") not in {None, str(self.home)}
                or endpoint.get("supervisor") != "systemd"
                or endpoint.get("runtime_protocol") != 1
                or type(endpoint.get("authority_epoch")) is not int or endpoint["authority_epoch"] <= 0
                or not isinstance(endpoint.get("instance_id"), str) or not endpoint["instance_id"]
                or endpoint.get("code_sha") != COMMIT or ready.get("client_code_sha") != COMMIT):
            refuse("native_gateway_reload_failed", "native_readiness_identity_mismatch", 1)
        if previous is not None and endpoint["instance_id"] == previous:
            refuse("native_gateway_reload_failed", "native_instance_unchanged", 1)
        self.service_check()
        output(native_gateway_reloaded=1)

    def create(self, config):
        restorable(config)
        # Values may themselves start with '--'. Equals-form options and the
        # positional delimiter preserve them as data in the tagged argparse CLI.
        args = ["create", "--name=" + config["name"], "--deliver=" + config["deliver"]]
        for skill in config["skills"]:
            args += ["--skill=" + skill]
        for key, flag in (("model", "--model"), ("provider", "--provider"), ("reasoning_effort", "--reasoning-effort"), ("failure_deliver", "--failure-deliver")):
            if config[key] is not None:
                args += [flag + "=" + config[key]]
        if not config["enabled"]:
            args += ["--paused", "--paused-reason=" + config["paused_reason"]]
        args += ["--", config["schedule"]["expr"], config["prompt"]]
        self.run(args)

    def dispatch(self, operation, args):
        if operation in {"service-check", "reload"}:
            if args and not (operation == "reload" and args == ["--interrupt-live-sessions"]):
                refuse("native_cron_invocation_invalid", "unexpected_arguments")
            if operation == "reload":
                self.reload(interrupt_live_sessions=bool(args))
            else:
                self.service_check()
                output(native_gateway_scope_ok=1)
            return
        if operation == "inspect":
            jobs = self.jobs()
            identifiers = sorted({item["managed_id"] for item in jobs if item["managed_id"] is not None})
            other = self.unrelated(jobs, set(identifiers))
            output(cron_managed_ids=",".join(identifiers), cron_other_count=len(other), cron_other_sig=digest(other))
            return
        if not args:
            refuse("native_cron_invocation_invalid", "missing_transaction")
        txn = self.txn(args[0], backup=operation == "backup")
        if operation == "backup":
            if (txn / BEFORE).exists() or (txn / BEFORE).is_symlink():
                refuse("native_cron_snapshot_invalid", "snapshot_exists")
            jobs = self.jobs()
            for item in jobs:
                if item["managed_id"] is not None:
                    restorable(item["config"])
            atomic_private(txn / BEFORE, {"format": FORMAT, "version": VERSION, "home": str(self.home), "jobs": jobs})
            identifiers = {item["managed_id"] for item in jobs if item["managed_id"] is not None}
            other = self.unrelated(jobs, identifiers)
            output(native_cron_backup=1, cron_other_count=len(other), cron_other_sig=digest(other))
            return
        before, plan = self.before(txn), self.plan(txn)
        if operation in {"preflight", "intend", "ensure"}:
            if len(args) != 4:
                refuse("native_cron_invocation_invalid", "invalid_plan_arguments")
            identifier, schedule, prompt = args[1:]
            config = desired(identifier, schedule, prompt)
            spec = {"schedule": valid_schedule(schedule), "prompt": prompt, "config": config}
            previous = plan["jobs"].get(identifier)
            if previous is not None and previous != spec:
                refuse("native_cron_snapshot_invalid", "plan_changed")
            if operation == "ensure" and previous is None:
                refuse("native_cron_snapshot_invalid", "plan_missing")
            plan["jobs"][identifier] = spec
            current = self.jobs()
            if operation in {"preflight", "intend"}:
                expected = self.configurations(before, identifier) if previous is None else None
                if previous is not None and (txn / "applied").exists():
                    expected = [config]
                if expected is not None and self.configurations(current, identifier) != expected:
                    refuse("native_cron_conflict", "managed_configuration_changed", 3)
            self.check(before, current, plan)
            if operation == "preflight":
                output(native_cron_preflight=1)
                return
            if operation == "intend":
                if previous is None:
                    atomic_private(txn / PLAN, plan)
                output(native_cron_intended=1)
                return
            actual = self.configurations(current, identifier)
            if actual == [config]:
                output(cron_result="unchanged")
                return
            old = [item for item in current if item["managed_id"] == identifier]
            self.create(config)
            for item in old:
                now = self.jobs()
                self.check(before, now, plan)
                if item in now:
                    self.run(["remove", item["id"]])
            now = self.jobs()
            self.check(before, now, plan)
            if self.configurations(now, identifier) != [config]:
                refuse("native_cron_cli_failed", "create_not_confirmed", 1)
            output(cron_result="updated" if old else "created")
            return
        if operation == "verify":
            if len(args) != 3:
                refuse("native_cron_invocation_invalid", "invalid_verify_arguments")
            identifier, schedule = args[1:]
            spec = plan["jobs"].get(identifier)
            if not spec or valid_schedule(schedule) != spec["schedule"]:
                refuse("native_cron_snapshot_invalid", "plan_missing")
            now = self.jobs()
            try:
                self.check(before, now, plan)
                unrelated = "pass"
            except Refusal as error:
                if error.detail != "unrelated_configuration_changed":
                    output(cron_check="fail", cron_detail="managed_configuration_changed", cron_unrelated_check="pass")
                    return
                unrelated = "fail"
            passed = self.configurations(now, identifier) == [spec["config"]]
            output(cron_check="pass" if passed else "fail", cron_detail="ok" if passed else "managed_configuration_changed", cron_unrelated_check=unrelated)
            return
        if operation in {"restore-check", "restore", "verify-restored"}:
            current = self.jobs()
            self.check(before, current, plan)
            if operation == "restore-check":
                output(native_cron_restore_check=1)
                return
            if operation == "restore":
                for identifier in sorted(plan["jobs"]):
                    prior = self.configurations(before, identifier)
                    if self.configurations(self.jobs(), identifier) == prior:
                        continue
                    # Restore originals before deleting this transaction's replacements.
                    # Interruption leaves only baseline/intended configurations, so retry
                    # remains conflict-safe; multiplicity is reconciled by exact counts.
                    existing = [item for item in self.jobs() if item["managed_id"] == identifier]
                    for config in prior:
                        matching = next((item for item in existing if item["config"] == config), None)
                        if matching:
                            existing.remove(matching)
                        else:
                            self.check(before, self.jobs(), plan)
                            self.create(config)
                    for item in existing:
                        now = self.jobs()
                        self.check(before, now, plan)
                        if item in now:
                            self.run(["remove", item["id"]])
                current = self.jobs()
                self.check(before, current, plan)
            if operation != "restore-check":
                for identifier in plan["jobs"]:
                    if self.configurations(current, identifier) != self.configurations(before, identifier):
                        refuse("native_cron_restore_failed", "restoration_not_confirmed", 1)
                output(native_cron_restored=1)
            return
        refuse("native_cron_invocation_invalid", "unknown_operation")


def main(argv):
    try:
        if len(argv) < 3:
            refuse("native_cron_invocation_invalid", "missing_arguments")
        Adapter(argv[0], argv[1]).dispatch(argv[2], argv[3:])
        return 0
    except Refusal as error:
        output(error=error.code, detail=error.detail)
        return error.status
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError, RecursionError):
        # Native job content and subprocess output may contain credentials or arbitrary
        # instructions. Diagnostics are fixed codes, never exception strings or values.
        output(error="native_cron_failed", detail="native_operation_unconfirmed")
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
