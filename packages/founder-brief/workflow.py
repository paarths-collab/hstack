"""A bounded GitHub-to-private-Telegram workflow, scheduled by native Hermes.

Repository text is rendered as data. No model, setup skill, shell expansion or
repository-supplied command is involved. A Telegram API acknowledgement is not
evidence that a human read the message.
"""
import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import getpass
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys
import tempfile
import warnings
import zipfile
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

VERSION = "0.22.5"
ROOT = ".hstack/founder-brief"
WORKFLOWS = {
    "activity-brief": {
        "name": "Repository activity",
        "collects": "Default-branch commits and issues/PRs updated during the reporting window",
        "sources": ["commits", "issues", "pulls"],
        "private_repository_permissions": ["Contents: read", "Issues: read", "Pull requests: read"],
        "omits": "Comments, review contents, other branches and a complete event history",
    },
    "review-queue": {
        "name": "PR review queue",
        "collects": "Current open, non-draft PRs with explicitly requested reviewers or teams, oldest first",
        "sources": ["pulls"],
        "private_repository_permissions": ["Pull requests: read"],
        "omits": "Unrequested PRs, completed review history, CI checks and merge readiness",
    },
    "release-watch": {
        "name": "Published releases",
        "collects": "Non-draft releases published during the reporting window, with prereleases labelled",
        "sources": ["releases"],
        "private_repository_permissions": ["Contents: read"],
        "omits": "Unpublished tags, draft releases, assets and dependency upgrade advice",
    },
}


class WorkflowError(Exception):
    def __init__(self, code, *, details=None):
        super().__init__(code)
        self.details = details


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def pairs(values):
    result = {}
    for key, value in values:
        if key in result:
            raise WorkflowError("duplicate_json_key")
        result[key] = value
    return result


def private_json(file, optional=False):
    fd = None
    try:
        fd = os.open(str(file), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_mode & 0o077 or info.st_size > 1024 * 1024:
            raise WorkflowError("private_regular_file_required")
        with os.fdopen(fd, "rb") as handle:
            fd = None
            raw = handle.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise WorkflowError("private_file_too_large")
        return json.loads(raw.decode(), object_pairs_hook=pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(WorkflowError("invalid_json")))
    except FileNotFoundError:
        if optional:
            return None
        raise WorkflowError("private_file_missing") from None
    except (OSError, ValueError, UnicodeError, RecursionError):
        raise WorkflowError("private_file_unreadable") from None
    finally:
        if fd is not None:
            os.close(fd)


def validate_config(value):
    required = {"schema_version", "repositories", "telegram_chat_id", "daily_time", "timezone", "window_hours"}
    if not isinstance(value, dict) or not required <= set(value) or set(value) - required - {"workflow"} or type(value["schema_version"]) is not int or value["schema_version"] != 1:
        raise WorkflowError("invalid_config_shape")
    if not isinstance(value.get("workflow", "activity-brief"), str) or value.get("workflow", "activity-brief") not in WORKFLOWS:
        raise WorkflowError("unknown_workflow")
    repos = value["repositories"]
    if not isinstance(repos, list) or not 1 <= len(repos) <= 8:
        raise WorkflowError("select_one_to_eight_repositories")
    for repo in repos:
        if not isinstance(repo, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}", repo) or repo.split("/")[1] in {".", ".."}:
            raise WorkflowError("invalid_repository")
    repos = sorted(repo.lower() for repo in repos)
    if len(set(repos)) != len(repos):
        raise WorkflowError("duplicate_repository")
    chat = value["telegram_chat_id"]
    if not isinstance(chat, str) or not re.fullmatch(r"[1-9][0-9]{0,15}", chat):
        raise WorkflowError("positive_private_chat_required")
    if not isinstance(value["daily_time"], str) or not re.fullmatch(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]", value["daily_time"]):
        raise WorkflowError("daily_time_requires_HH_MM")
    if type(value["window_hours"]) is not int or not 1 <= value["window_hours"] <= 168:
        raise WorkflowError("invalid_reporting_window")
    try:
        if not isinstance(value["timezone"], str) or len(value["timezone"]) > 80:
            raise WorkflowError("invalid_timezone")
        ZoneInfo(value["timezone"])
    except (ZoneInfoNotFoundError, ValueError, TypeError):
        raise WorkflowError("unknown_timezone") from None
    return {**value, "repositories": repos}


def validate_credentials(value):
    if not isinstance(value, dict) or set(value) - {"GITHUB_TOKEN", "TELEGRAM_BOT_TOKEN"}:
        raise WorkflowError("invalid_credentials_shape")
    bot = value.get("TELEGRAM_BOT_TOKEN")
    github = value.get("GITHUB_TOKEN", "")
    if not isinstance(bot, str) or not re.fullmatch(r"[0-9]{5,20}:[A-Za-z0-9_-]{20,200}", bot):
        raise WorkflowError("invalid_telegram_token")
    if not isinstance(github, str) or len(github) > 4096 or (github and not re.fullmatch(r"[A-Za-z0-9_]+", github)):
        raise WorkflowError("invalid_github_token")
    return {"GITHUB_TOKEN": github, "TELEGRAM_BOT_TOKEN": bot}


def home_path(value):
    path = Path(value).absolute()
    if path.name != ".hermes" or path.is_symlink() or not path.is_dir() or "profiles" in path.parts:
        raise WorkflowError("default_hermes_home_required")
    return path.resolve()


def utc(value):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError()
        return parsed.astimezone(timezone.utc)
    except (ValueError, TypeError, AttributeError):
        raise WorkflowError("invalid_timestamp") from None


def iso(value):
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def reporting_window(config, now=None):
    """Latest local daily cutoff; gaps shift forward, repeated hours use fold 0."""
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    zone = ZoneInfo(config["timezone"])
    day = now.astimezone(zone).date()
    hour, minute = map(int, config["daily_time"].split(":"))

    def cutoff(date):
        return datetime(date.year, date.month, date.day, hour, minute, tzinfo=zone, fold=0).astimezone(timezone.utc)

    end = cutoff(day)
    if end > now:
        day -= timedelta(days=1)
        end = cutoff(day)
    start = end - timedelta(hours=config["window_hours"])
    return {"window_id": "daily:" + day.isoformat(), "start": iso(start), "end": iso(end)}


def collector_module():
    try:
        import github_brief
        return github_brief
    except ModuleNotFoundError:
        spec = importlib.util.spec_from_file_location("github_brief", Path(__file__).with_name("github-brief.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module


def collect_report(config, start, end, *, _client=None, github_token=""):
    """Shared read-only report path for preview, scheduled delivery and comparison."""
    collector = collector_module()
    raw = {"schema_version": 1, "repositories": config["repositories"], "start": start, "end": end}
    if "workflow" in config:
        raw["workflow"] = config["workflow"]
    selected = collector.validate_config(raw)
    result = collector.collect(selected, _client or collector.GitHubClient(github_token))
    if not result.get("complete"):
        # Expose fixed reason codes so preview can distinguish a quiet repo,
        # missing access, API quota and a collection bound. Never echo responses.
        failures = []
        for index, report in enumerate(result["repositories"], 1):
            for source, status in report["sources"].items():
                if status["status"] == "ok":
                    continue
                reason = status.get("error", status["status"])
                if not isinstance(reason, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,60}", reason):
                    reason = "collection_failed"
                failures.append({"repository_index": index, "source": source,
                                 "status": status["status"], "reason": reason})
        reasons = {failure["reason"] for failure in failures}
        hint = "Check the selected source access and the collection limits in the pack guide."
        if "rate_limited" in reasons:
            hint = "Use a GitHub read token, or wait for the API rate limit to reset."
        elif reasons & {"http_401", "http_403", "http_404"}:
            hint = "Check the selected repositories and the token's read permissions."
        elif "truncated" in reasons:
            hint = "The bounded scan is incomplete; see the pack's volume limits before selecting a repository or activity window."
        raise WorkflowError("github_collection_incomplete", details={"sources": failures, "hint": hint})
    return collector.render(result)


def preview(config, *, github_token="", now=None, _client=None):
    """Fetch a report without touching Hermes, deployment state or Telegram."""
    config = validate_config(config)
    end = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    return collect_report(config, iso(end - timedelta(hours=config["window_hours"])), iso(end),
                          _client=_client, github_token=github_token)


def save_credentials(file, *, _prompt=None):
    """Capture secrets privately, without command-line arguments or JSON editing."""
    file = Path(file).absolute()
    parent = file.parent.lstat()
    if (file.parent.is_symlink() or not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid()
            or stat.S_IMODE(parent.st_mode) != 0o700):
        raise WorkflowError("credentials_require_private_directory")
    if file.exists() or file.is_symlink():
        raise WorkflowError("refusing_existing_credentials")
    if _prompt is None:
        if not sys.stdin.isatty():
            raise WorkflowError("credentials_require_interactive_terminal")
        _prompt = getpass.getpass
    try:
        # getpass otherwise warns and falls back to echoed input on terminals
        # that cannot disable echo. Refuse before that fallback can read a token.
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            value = validate_credentials({
                "TELEGRAM_BOT_TOKEN": _prompt("Telegram bot token (hidden): "),
                "GITHUB_TOKEN": _prompt("GitHub read token (hidden; Enter for public repositories): "),
            })
    except (getpass.GetPassWarning, EOFError):
        raise WorkflowError("credentials_require_hidden_terminal") from None
    fd, temp = tempfile.mkstemp(prefix=".credentials-", dir=str(file.parent))
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write((canonical(value) + "\n").encode())
            handle.flush()
            os.fsync(handle.fileno())
        os.link(temp, file)  # A concurrent writer can never be overwritten.
        directory = os.open(str(file.parent), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except FileExistsError:
        raise WorkflowError("refusing_existing_credentials") from None
    finally:
        os.unlink(temp)
    return {"status": "credentials_saved", "file": str(file)}


def state_directory(base):
    path = base / "state"
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise WorkflowError("unsafe_workflow_state")
    return path


def atomic_json(file, value):
    private_json(file, optional=True)  # Refuse symlinks, hardlinks and unsafe prior files.
    fd, temp = tempfile.mkstemp(prefix=".request-", dir=str(file.parent))
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write((canonical(value) + "\n").encode())
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, file)
        directory = os.open(str(file.parent), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def deployment_for(home, supplied=None):
    if supplied is not None:
        if supplied.home != home:
            raise WorkflowError("deployment_target_mismatch")
        return supplied
    from deployment import Deployment
    raw = private_json(home / ROOT / "installation.json")
    if not isinstance(raw, dict) or not isinstance(raw.get("hermes"), str):
        raise WorkflowError("installation_not_complete")
    return Deployment(home, raw["hermes"])


def canary_request(base, config, canary_id, now, create=False):
    if not isinstance(canary_id, str) or not re.fullmatch(r"[a-f0-9]{32}", canary_id):
        raise WorkflowError("invalid_canary_id")
    state = state_directory(base)
    directory = state / "canaries"
    if create and not directory.exists():
        directory.mkdir(mode=0o700)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise WorkflowError("unsafe_workflow_state")
    file = directory / (canary_id + ".json")
    request = private_json(file, optional=True)
    if request is None and create:
        request = {"schema_version": 1, "canary_id": canary_id, "config_hash": digest(config), "created_at": iso(now),
                   "window_id": "canary:" + canary_id, "start": iso(now - timedelta(hours=config["window_hours"])), "end": iso(now)}
        atomic_json(file, request)
    expected = {"schema_version", "canary_id", "config_hash", "created_at", "window_id", "start", "end"}
    if (not isinstance(request, dict) or set(request) != expected or request["schema_version"] != 1
            or request["canary_id"] != canary_id or request["config_hash"] != digest(config)
            or request["window_id"] != "canary:" + canary_id or request["created_at"] != request["end"]
            or utc(request["end"]) - utc(request["start"]) != timedelta(hours=config["window_hours"])
            or utc(request["end"]) > now + timedelta(seconds=30)):
        raise WorkflowError("invalid_canary_request")
    return request


def execute(home, *, canary_id=None, now=None, _github_client=None, _telegram_client=None, _deployment=None):
    """Run the real collector and sender; test seams are Python-only arguments."""
    from telegram_delivery import TelegramDelivery, DeliveryUnknown
    home = home_path(home)
    base = home / ROOT
    deployment = deployment_for(home, _deployment)
    # Installation, updates and rollback share this kernel lock. No request can
    # send from a partly replaced payload or silently drift from reviewed bytes.
    with deployment.runtime_guard() as installation:
        deployment.verify_installation(verify_job=True)
        config = validate_config(private_json(base / "config.json"))
        credentials = validate_credentials(private_json(base / "credentials.json"))
        now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
        state = state_directory(base)
        pointer = private_json(state / "canary-request.json", optional=True)
        if canary_id is None and pointer is not None:
            if (not isinstance(pointer, dict) or set(pointer) != {"canary_id", "phase"}
                    or pointer["phase"] not in {"pending", "complete", "blocked", "expired"}):
                raise WorkflowError("invalid_canary_request")
            if pointer["phase"] == "pending":
                canary_id = pointer["canary_id"]
        if canary_id is None:
            window = reporting_window(config, now)
            if utc(window["end"]) < utc(installation.get("installed_at")):
                return {"status": "waiting_for_daily_cutoff", "evidence_scope": "no_message_sent"}
        else:
            window = canary_request(base, config, canary_id, now, create=True)
        config_hash = digest(config)
        run_id = hashlib.sha256((config_hash + ":" + window["window_id"]).encode()).hexdigest()[:32]
        sender = TelegramDelivery(state, credentials["TELEGRAM_BOT_TOKEN"], credentials["GITHUB_TOKEN"],
                                  **({"_client": _telegram_client} if _telegram_client is not None else {}))
        try:
            proof = sender.lookup(config_hash=config_hash, window_id=window["window_id"], chat_id=config["telegram_chat_id"])
        except DeliveryUnknown:
            if pointer is not None and pointer.get("canary_id") == canary_id:
                atomic_json(state / "canary-request.json", {"canary_id": canary_id, "phase": "blocked"})
            raise
        if proof is not None:
            if pointer is not None and pointer.get("canary_id") == canary_id and pointer["phase"] == "pending":
                atomic_json(state / "canary-request.json", {"canary_id": canary_id, "phase": "complete"})
            return proof
        if canary_id is not None and now - utc(window["created_at"]) > timedelta(minutes=30):
            if pointer is not None and pointer.get("canary_id") == canary_id:
                atomic_json(state / "canary-request.json", {"canary_id": canary_id, "phase": "expired"})
            raise WorkflowError("canary_expired_no_message_sent")
        body = collect_report(config, window["start"], window["end"],
                              _client=_github_client, github_token=credentials["GITHUB_TOKEN"])
        for token in credentials.values():
            if token:
                body = body.replace(token, "[redacted]")
        try:
            proof = sender.deliver(run_id=run_id, config_hash=config_hash, window_id=window["window_id"], body=body,
                                   chat_id=config["telegram_chat_id"])
        except DeliveryUnknown:
            if pointer is not None and pointer.get("canary_id") == canary_id:
                atomic_json(state / "canary-request.json", {"canary_id": canary_id, "phase": "blocked"})
            raise
        if pointer is not None and pointer.get("canary_id") == canary_id:
            atomic_json(state / "canary-request.json", {"canary_id": canary_id, "phase": "complete"})
        return proof


LAUNCHER = b'''# hstack-owned founder brief launcher v1\nimport os\nimport sys\nhome = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))\nruntime = os.path.join(home, ".hstack", "founder-brief", "runtime.pyz")\nos.execv(sys.executable, [sys.executable, "-I", "-B", runtime, "scheduled", "--home", home])\n'''


def safe_summary(value):
    # Output is a receipt/status, never source text, credentials or raw chat IDs.
    return canonical(value)


def run_canary(home, approval, canary_id, *, now=None, _deployment=None, _dispatch=None):
    """Arm one immutable window, dispatch native cron, require its API proof."""
    from telegram_delivery import TelegramDelivery
    home = home_path(home)
    deployment = deployment_for(home, _deployment)
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    base = home / ROOT
    with deployment.runtime_guard() as record:
        deployment.verify_installation(verify_job=True)
        if approval != record["review_hash"]:
            raise WorkflowError("approval_hash_mismatch")
        config = validate_config(private_json(base / "config.json"))
        request = canary_request(base, config, canary_id, now, create=True)
        pointer_file = state_directory(base) / "canary-request.json"
        pointer = private_json(pointer_file, optional=True)
        if pointer is not None and pointer.get("phase") == "pending" and pointer.get("canary_id") != canary_id:
            raise WorkflowError("another_canary_is_pending")
        atomic_json(pointer_file, {"canary_id": canary_id, "phase": "pending"})
        job_id = record["job_id"]
        args = [record["hermes"], "--profile", "default", "cron", "run", job_id]
    # Do not hold the runtime lock here: the actual native child needs that lock.
    if _dispatch is None:
        env = {key: value for key, value in os.environ.items() if not key.startswith("HERMES_SESSION_") and key != "HERMES_CRON_SESSION"}
        env.update(HERMES_HOME=str(home), HERMES_PROFILE="default", HERMES_PROFILE_NAME="default")
        try:
            result = subprocess.run(args, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL, timeout=240, check=False)
            code = result.returncode
        except (OSError, subprocess.SubprocessError):
            raise WorkflowError("native_canary_outcome_unknown_check_status") from None
    else:
        code = _dispatch(args)
    with deployment.runtime_guard():
        credentials = validate_credentials(private_json(base / "credentials.json"))
        sender = TelegramDelivery(state_directory(base), credentials["TELEGRAM_BOT_TOKEN"], credentials["GITHUB_TOKEN"])
        proof = sender.lookup(config_hash=digest(config), window_id=request["window_id"], chat_id=config["telegram_chat_id"])
        expected_run = hashlib.sha256((digest(config) + ":" + request["window_id"]).encode()).hexdigest()[:32]
        if proof is None or proof.get("run_id") != expected_run:
            raise WorkflowError("native_canary_has_no_matching_api_ack")
        if type(code) is not int or code != 0:
            raise WorkflowError("native_command_failed_delivery_ack_retained")
        return {"native_job_id": job_id, "native_command": "cron run", "canary_id": canary_id, "delivery": proof}


def main(argv=None):
    # Prepare owns its flags, and runs without a Hermes target or credentials.
    command_args = list(sys.argv[1:] if argv is None else argv)
    if command_args and command_args[0] == "prepare":
        import prepare
        runtime = Path(sys.argv[0])
        return prepare.main(command_args[1:], runtime_bytes=runtime.read_bytes() if zipfile.is_zipfile(runtime) else None)
    parser = argparse.ArgumentParser(description="Prepare, preview and run ready-to-use GitHub workflows")
    subs = parser.add_subparsers(dest="command", required=True)
    subs.add_parser("packs", help="List the three workflows and their scope")
    p = subs.add_parser("credentials", help="Write a new private credential file using hidden terminal prompts")
    p.add_argument("--output", type=Path, required=True)
    p = subs.add_parser("preview", help="Fetch the selected report without installing or sending it")
    p.add_argument("--config", type=Path, required=True)
    p.add_argument("--credentials", type=Path)
    for command in ("review", "install"):
        p = subs.add_parser(command)
        p.add_argument("--home", type=Path, required=True)
        p.add_argument("--hermes", type=Path, required=True)
        p.add_argument("--config", type=Path, required=True)
        if command == "install":
            p.add_argument("--credentials", type=Path, required=True)
            p.add_argument("--approve", required=True)
    for command in ("scheduled", "canary", "status", "rollback"):
        p = subs.add_parser(command)
        p.add_argument("--home", type=Path, required=True)
        if command in {"canary", "rollback"}:
            p.add_argument("--approve", required=True)
        if command == "canary":
            p.add_argument("--run-id", help="Reuse the printed canary ID after an interrupted attempt")
    args = parser.parse_args(command_args)
    try:
        if args.command == "credentials":
            print(safe_summary(save_credentials(args.output)))
            return 0
        if args.command == "packs":
            print(safe_summary({"workflows": [{"id": key, **value} for key, value in WORKFLOWS.items()],
                                "installation_scope": "one_selected_workflow_per_default_profile_target",
                                "requirements": "Linux, exact Hermes 0.22.5 candidate, Python 3.9+, private Telegram chat",
                                "limits": "1-8 repositories; 3 pages of 100 items per source; 2 MiB per response; 90 seconds collection",
                                "access": "Public repositories: optional token. Private: grant the selected repositories and the read permissions listed for that pack."}))
            return 0
        if args.command == "preview":
            config = validate_config(private_json(args.config))
            token = ""
            secrets_to_redact = []
            if args.credentials:
                credentials = private_json(args.credentials)
                if not isinstance(credentials, dict) or set(credentials) - {"GITHUB_TOKEN", "TELEGRAM_BOT_TOKEN"}:
                    raise WorkflowError("invalid_credentials_shape")
                token = credentials.get("GITHUB_TOKEN", "")
                # Same grammar as the collector; never expose a malformed value.
                if not isinstance(token, str) or len(token) > 4096 or (token and not re.fullmatch(r"[A-Za-z0-9_]+", token)):
                    raise WorkflowError("invalid_github_token")
                secrets_to_redact = [value for value in credentials.values() if isinstance(value, str) and value]
            body = preview(config, github_token=token)
            for secret in secrets_to_redact:
                body = body.replace(secret, "[redacted]")
            print(body)
            return 0
        home = home_path(args.home)
        base = home / ROOT
        if args.command in {"review", "install"}:
            from deployment import Deployment
            config = validate_config(private_json(args.config))
            bundle = Path(sys.argv[0]).read_bytes()
            deployment = Deployment(home, str(args.hermes))
            review = deployment.review_descriptor(bundle, LAUNCHER, config)
            review_hash = deployment.review_hash(bundle, LAUNCHER, config)
            if args.command == "review":
                print(safe_summary({"plan_hash": review_hash, "review": review, "evidence_scope": "offline_plan_only"}))
                return 0
            if args.approve != review_hash:
                raise WorkflowError("approval_hash_mismatch")
            credentials = validate_credentials(private_json(args.credentials))
            print(safe_summary(deployment.install(bundle, LAUNCHER, config, credentials)))
            return 0
        if args.command == "scheduled":
            print(safe_summary(execute(home)))
            return 0
        record = private_json(base / "installation.json")
        if args.command == "status":
            print(safe_summary({key: record.get(key) for key in ("phase", "installed_at", "review_hash", "job_id")}))
            return 0
        if args.approve != record.get("review_hash"):
            raise WorkflowError("approval_hash_mismatch")
        if args.command == "rollback":
            from deployment import Deployment
            print(safe_summary(Deployment(home, record["hermes"]).rollback()))
            return 0
        # An explicit canary uses the same runtime/collector/sender as the scheduled job.
        # The canary ID is printed before any network request, allowing an interrupted
        # attempt to be reconciled without silently choosing another delivery identity.
        canary_id = args.run_id or secrets.token_hex(16)
        print(safe_summary({"canary_id": canary_id, "status": "starting", "evidence_scope": "not_yet_observed"}), flush=True)
        print(safe_summary(run_canary(home, args.approve, canary_id)))
        return 0
    except Exception as error:
        # Every expected module exception carries a fixed code; never print raw
        # HTTP/process/file exceptions, which can contain private URLs and secrets.
        code = str(error) if isinstance(error, WorkflowError) else getattr(error, "code", "workflow_failed")
        if not isinstance(code, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,95}", code):
            code = "workflow_failed"
        from telegram_delivery import DeliveryUnknown
        unknown = isinstance(error, DeliveryUnknown) or code == "native_canary_outcome_unknown_check_status"
        summary = {"status": "unknown" if unknown else "unverified", "error": code,
                   "reconciliation_required": unknown}
        if isinstance(error, WorkflowError) and error.details is not None:
            summary["details"] = error.details
        print(safe_summary(summary), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
