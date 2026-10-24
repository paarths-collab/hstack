#!/usr/bin/env python3
"""Executable setup comparison. Fake credentials, native CLI fixture, real local HTTP.

This measures the two supplied transcripts, not human setup time. Both arms get
the same collector/sender/window implementation for free. Nothing contacts a
vendor, installs Hermes, changes authentication or sends a real message.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlsplit

REPO = Path(__file__).resolve().parents[3]
SOURCE = REPO / "packages/founder-brief"
SELF = Path(__file__).resolve()
NOW = "2026-10-23T08:00:00Z"
CANARY = "a" * 32
BOT = "123456:" + "FAKE" + "x" * 32
CREDENTIALS = {"GITHUB_TOKEN": "ghp_" + "FAKE" * 8, "TELEGRAM_BOT_TOKEN": BOT}
WORKFLOWS = ("activity-brief", "review-queue", "release-watch")
CHOICES = ["workflow", "repositories", "telegram_chat_id", "daily_time", "timezone"]

# This is the complete manual-native worker the comparator supplies for free.
# A real operator would integrate equivalent code, or ask Hermes to write it.
# Its scope is report/ack/replay parity, not hstack's deployment guarantees.
NATIVE_WORKER = '''"""Supplied manual-native comparison worker; no installation receipt or rollback guard."""
import hashlib
import json
from pathlib import Path
import sys

def run(home, now=None, _github_client=None, _telegram_client=None):
    base = Path(home) / "manual-brief"
    sys.path.insert(0, str(base / "runtime.pyz"))
    import workflow
    from telegram_delivery import TelegramDelivery
    config = workflow.validate_config(workflow.private_json(base / "config.json"))
    credentials = workflow.validate_credentials(workflow.private_json(base / "credentials.json"))
    window = workflow.reporting_window(config, now)
    config_hash = workflow.digest(config)
    sender = TelegramDelivery(base / "state", credentials["TELEGRAM_BOT_TOKEN"], credentials["GITHUB_TOKEN"],
        **({"_client": _telegram_client} if _telegram_client is not None else {}))
    proof = sender.lookup(config_hash=config_hash, window_id=window["window_id"], chat_id=config["telegram_chat_id"])
    if proof is not None:
        return proof
    body = workflow.collect_report(config, window["start"], window["end"],
        _client=_github_client, github_token=credentials["GITHUB_TOKEN"])
    for token in credentials.values():
        if token:
            body = body.replace(token, "[redacted]")
    run_id = hashlib.sha256((config_hash + ":" + window["window_id"]).encode()).hexdigest()[:32]
    return sender.deliver(run_id=run_id, config_hash=config_hash, window_id=window["window_id"],
        body=body, chat_id=config["telegram_chat_id"])

if __name__ == "__main__":
    print(json.dumps(run(Path.home() / ".hermes")))
'''


def modules(runtime=None):
    sys.path.insert(0, str(runtime or SOURCE))
    if runtime is None:
        spec = importlib.util.spec_from_file_location("native_adapter", REPO / "packages/acceptance/target/native-hermes-v0_22_5.py")
        value = importlib.util.module_from_spec(spec)
        sys.modules["native_adapter"] = value
        spec.loader.exec_module(value)
    import workflow
    import deployment
    return workflow, deployment


def write_json(path, value):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.write_text(json.dumps(value, sort_keys=True) + "\n")
    path.chmod(0o600)


def config(pack):
    return {"schema_version": 1, "workflow": pack, "instance_id": pack, "repositories": ["acme/widget"],
            "telegram_chat_id": "555000111", "daily_time": "08:00", "timezone": "UTC", "window_hours": 24}


def telegram_client(port):
    def request(method, payload):
        client = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        try:
            client.request("POST", "/synthetic-bot/" + method, json.dumps(payload), {"Content-Type": "application/json"})
            response = client.getresponse()
            return response.status, dict(response.headers), response.read()
        finally:
            client.close()
    return request


def worker(home, arm):
    pack = os.environ["HSTACK_COMPARISON_PACK"]
    runtime = home / (".hstack/workflows/" + pack + "/runtime.pyz" if arm == "hstack" else "manual-brief/runtime.pyz")
    workflow, deployment = modules(runtime)
    collector = workflow.collector_module()
    port = int(os.environ["HSTACK_COMPARISON_HTTP_PORT"])
    github = collector.GitHubClient._for_test("http://127.0.0.1:" + str(port), token=CREDENTIALS["GITHUB_TOKEN"])
    now = workflow.utc(NOW)
    if arm == "hstack":
        dep = deployment.Deployment(home, home.parent / "hermes-fixture", instance_id=pack, offline=True)
        result = workflow.execute(home, instance_id=pack, now=now, _github_client=github, _telegram_client=telegram_client(port), _deployment=dep)
    else:
        namespace = runpy.run_path(str(home / "scripts/manual-brief.py"))
        result = namespace["run"](home, now, github, telegram_client(port))
    print(json.dumps(result))


def operation(step, root, pack):
    """One measured process invocation. Test seams never enter production flags."""
    home, prepared = root / ".hermes", root / "prepared"
    hermes = root / "hermes-fixture"
    if step == "worker":
        return worker(home, os.environ["HSTACK_COMPARISON_ARM"])
    workflow, deployment = modules()
    if step == "native-write-config":
        write_json(root / "manual-config.json", config(pack))
        print(json.dumps({"status": "authored", "fields": len(config(pack))}))
        return
    if step == "native-publish-worker":
        base = home / "manual-brief"
        base.mkdir(mode=0o700)
        (base / "state").mkdir(mode=0o700)
        for source, target in ((root / "runtime.pyz", base / "runtime.pyz"),
                               (root / "manual-config.json", base / "config.json"),
                               (root / "credentials.json", base / "credentials.json")):
            shutil.copyfile(source, target)
            target.chmod(0o600)
        launcher = home / "scripts/manual-brief.py"
        launcher.write_text(NATIVE_WORKER)
        launcher.chmod(0o700)
        print(json.dumps({"status": "published"}))
        return
    if step == "native-cleanup":
        (home / "scripts/manual-brief.py").unlink()
        # Retain the same delivery evidence the hstack arm retains.
        for name in ("runtime.pyz", "config.json", "credentials.json"):
            (home / "manual-brief" / name).unlink()
        print(json.dumps({"status": "removed", "evidence_retained": True}))
        return
    original = deployment.Deployment
    def offline_deployment(target, executable, **kwargs):
        kwargs["offline"] = True
        return original(target, executable, **kwargs)
    deployment.Deployment = offline_deployment
    runtime = prepared / "hstack-brief.pyz"
    if step == "prepare":
        import prepare
        raise SystemExit(prepare.main(["--workflow", pack, "--repository", "acme/widget", "--chat-id", "555000111",
            "--at", "08:00", "--timezone", "UTC", "--output", str(prepared)], runtime_bytes=(root / "runtime.pyz").read_bytes()))
    # The preparation manifest owns filenames; do not duplicate its convention.
    metadata = json.loads((root / "prepare-result.json").read_text())
    runtime = Path(metadata["files"]["runtime"])
    selected = Path(metadata["files"]["config"])
    sys.argv[0] = str(runtime)
    common = ["--home", str(home)]
    if step in {"review", "install"}:
        args = [step] + common + ["--hermes", str(hermes), "--config", str(selected)]
        if step == "install":
            args += ["--credentials", str(root / "credentials.json"), "--approve", (root / "approval").read_text()]
    elif step in {"canary", "canary-replay"}:
        original_canary = workflow.run_canary
        workflow.run_canary = lambda target, approval, identity, **kwargs: original_canary(target, approval, identity, now=workflow.utc(NOW), **kwargs)
        args = ["canary"] + common + ["--instance", pack, "--approve", (root / "approval").read_text(), "--run-id", CANARY]
    else:
        args = ["rollback"] + common + ["--instance", pack, "--approve", (root / "approval").read_text()]
    raise SystemExit(workflow.main(args))


class Api:
    def __init__(self):
        self.calls, self.bodies = [], []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def answer(self, value):
                raw = json.dumps(value).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                path = urlsplit(self.path).path
                owner.calls.append(["GET", path])
                if path.endswith("/commits"):
                    value = [{"sha": "b" * 40, "commit": {"committer": {"date": "2026-10-23T07:00:00Z"}, "message": "Fix queue delivery"}}]
                elif path.endswith("/issues"):
                    value = [{"number": 7, "updated_at": "2026-10-23T07:10:00Z", "state": "open", "title": "Investigate retry error"}]
                elif path.endswith("/pulls"):
                    value = [{"number": 8, "updated_at": "2026-10-23T07:15:00Z", "created_at": "2026-10-20T06:00:00Z",
                              "state": "open", "draft": False, "user": {"login": "review-author"},
                              "requested_reviewers": [{"login": "reviewer"}], "requested_teams": [], "title": "Review delivery guard"}]
                elif path.endswith("/releases"):
                    value = [{"id": 9, "draft": False, "prerelease": False, "tag_name": "v1.2.3", "name": "Reliable release",
                              "published_at": "2026-10-23T07:20:00Z"}]
                else:
                    raise AssertionError("unapproved endpoint: " + path)
                self.answer(value)

            def do_POST(self):
                method = self.path.rsplit("/", 1)[-1]
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                owner.calls.append(["POST", method])
                if method == "getMe":
                    result = {"id": 123456, "is_bot": True}
                elif method == "getChat":
                    result = {"id": 555000111, "type": "private"}
                elif method == "sendMessage":
                    owner.bodies.append(payload["text"])
                    result = {"message_id": len(owner.bodies), "date": int(time.time()), "from": {"id": 123456, "is_bot": True},
                              "chat": {"id": 555000111, "type": "private"}, "text": payload["text"]}
                else:
                    raise AssertionError("unapproved Telegram operation")
                self.answer({"ok": True, "result": result})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


def native_fixture(root):
    source = SELF.with_name("native-hermes-v0_22_5.py").read_text()
    branch = '''elif args[1]=="run":
 import subprocess
 raise SystemExit(subprocess.run([sys.executable,"-I","-B",os.environ["HSTACK_COMPARISON_HELPER"],"--step","worker","--root",str(home.parent),"--pack",os.environ["HSTACK_COMPARISON_PACK"]],check=False).returncode)
else:sys.exit(92)'''
    assert source.count("else:sys.exit(92)") == 1
    file = root / "hermes-fixture"
    file.write_text(source.replace("else:sys.exit(92)", branch))
    file.chmod(0o700)
    return file


def arm(api, pack, kind, bundle):
    from time import perf_counter
    with tempfile.TemporaryDirectory(prefix="hstack-workflow-comparison-") as temporary:
        root = Path(temporary).resolve()
        home = root / ".hermes"
        (home / "scripts").mkdir(mode=0o700, parents=True)
        foreign = {"id": "unrelated", "name": "Operator job", "prompt": "Leave unchanged", "schedule": {"kind": "cron", "expr": "0 2 * * *"}, "repeat": {"times": None}}
        write_json(home / "cron/jobs.json", {"jobs": [foreign]})
        write_json(root / "credentials.json", CREDENTIALS)
        (root / "runtime.pyz").write_bytes(bundle)
        hermes = native_fixture(root)
        env = {**os.environ, "HERMES_HOME": str(home), "HSTACK_COMPARISON_HTTP_PORT": str(api.server.server_port),
               "HSTACK_COMPARISON_HELPER": str(SELF), "HSTACK_COMPARISON_PACK": pack, "HSTACK_COMPARISON_ARM": kind}
        ledger = []
        first_call, first_body = len(api.calls), len(api.bodies)

        def invoke(step, args=None, setup=False):
            command = args or [sys.executable, "-I", "-B", str(SELF), "--step", step, "--root", str(root), "--pack", pack]
            started = perf_counter()
            result = subprocess.run(command, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=False)
            elapsed = round((perf_counter() - started) * 1000, 3)
            if result.returncode:
                raise AssertionError(step + " failed: " + result.stderr.replace(str(root), "<target>"))
            ledger.append({"operation": step, "phase": "setup" if setup else "validation_or_cleanup", "machine_elapsed_ms": elapsed})
            records = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
            return records[-1] if records else None

        if kind == "hstack":
            preparation = invoke("prepare", setup=True)
            write_json(root / "prepare-result.json", preparation)
            reviewed = invoke("review", setup=True)
            (root / "approval").write_text(reviewed["plan_hash"])
            installed = invoke("install", setup=True)
            job_id = installed["job_id"]
        else:
            invoke("native-write-config", setup=True)
            invoke("native-publish-worker", setup=True)
            invoke("native-cron-create", [str(hermes), "--profile", "default", "cron", "create", "--script=manual-brief.py", "--no-agent",
                "--deliver=local", "--failure-deliver=local", "--name=manual-comparison", "--", "* * * * *", "Run supplied workflow"], setup=True)
            job_id = json.loads((home / "cron/jobs.json").read_text())["jobs"][-1]["id"]
        jobs = json.loads((home / "cron/jobs.json").read_text())["jobs"]
        job = next(value for value in jobs if value["id"] == job_id)
        assert job["no_agent"] and job["deliver"] == job["failure_deliver"] == "local"
        assert job["schedule"] == {"kind": "cron", "expr": "* * * * *"}
        assert job["script"] == ("hstack-workflow-" + pack + ".py" if kind == "hstack" else "manual-brief.py")
        if kind == "hstack":
            one = invoke("canary")
            before_replay = len(api.calls)
            two = invoke("canary-replay")
            assert one == two
            assert one["delivery"]["evidence_scope"] == "telegram-api-ack"
            invoke("rollback")
        else:
            one = invoke("native-cron-run", [str(hermes), "--profile", "default", "cron", "run", job_id])
            before_replay = len(api.calls)
            two = invoke("native-cron-replay", [str(hermes), "--profile", "default", "cron", "run", job_id])
            assert one == two and one["evidence_scope"] == "telegram-api-ack"
            invoke("native-cron-remove", [str(hermes), "--profile", "default", "cron", "remove", job_id])
            invoke("native-cleanup")
        assert len(api.calls) == before_replay, "confirmed replay/cleanup must not make HTTP requests"
        assert len(api.bodies) - first_body == 1
        assert json.loads((home / "cron/jobs.json").read_text())["jobs"] == [foreign]
        if kind == "hstack":
            base, launcher = home / ".hstack/workflows" / pack, home / "scripts" / ("hstack-workflow-" + pack + ".py")
        else:
            base, launcher = home / "manual-brief", home / "scripts/manual-brief.py"
        assert not launcher.exists() and not launcher.is_symlink(), "cleanup must retire the owned launcher"
        assert all(not (base / name).exists() and not (base / name).is_symlink()
                   for name in ("runtime.pyz", "config.json", "credentials.json")), "cleanup must remove the private payload"
        journals = list((base / "state").glob("*.journal.json"))
        receipts = list((base / "state").glob("*.receipt.json"))
        assert len(journals) == len(receipts) == 1, "cleanup must retain delivery evidence"
        assert json.loads(journals[0].read_text())["phase"] == "confirmed"
        assert json.loads(receipts[0].read_text())["evidence_scope"] == "telegram-api-ack"
        argv = [json.loads(line) for line in (home / "fixture-argv.jsonl").read_text().splitlines()]
        assert all(values[:2] == ["--profile", "default"] for values in argv)
        calls = api.calls[first_call:]
        endpoints = [["GET", "/repos/acme/widget/" + source] for source in
                     ({"activity-brief": ["commits", "issues", "pulls"], "review-queue": ["pulls"], "release-watch": ["releases"]}[pack])]
        assert calls == endpoints + [["POST", value] for value in ("getMe", "getChat", "sendMessage")]
        body = api.bodies[first_body]
        checks = {"selected_endpoints_only": True, "private_telegram_api_ack": True, "replay_without_http": True,
                  "single_send": True, "native_default_profile": True, "native_script_no_agent": True, "unrelated_job_preserved": True,
                  "cleanup_launcher_absent": True, "cleanup_private_payload_absent": True, "cleanup_delivery_evidence_retained": True}
        return {"arm": kind, "setup_process_invocations": sum(row["phase"] == "setup" for row in ledger),
                "full_transcript_process_invocations": len(ledger), "operator_choices": CHOICES,
                "runbook_supplied_integration_artifacts": [] if kind == "hstack" else ["config.json", "manual-brief.py"],
                "runbook_supplied_config_fields": 0 if kind == "hstack" else len(config(pack)),
                "runbook_supplied_worker_nonblank_lines": 0 if kind == "hstack" else sum(bool(line.strip()) for line in NATIVE_WORKER.splitlines()),
                "metric_provenance": {
                    "process_invocations": "Observed subprocess ledger entries in this executed transcript.",
                    "integration_artifacts": "Classified from the two runbook artifact constants; no observed human assembly.",
                    "configuration_fields": "Count of keys in the supplied config(pack) fixture, not observed user authoring.",
                    "worker_nonblank_lines": "Count of nonblank lines in supplied NATIVE_WORKER constant, not observed user coding.",
                    "operator_choices": "Five explicit fixture inputs, not a count of mandatory CLI flags or observed user decisions.",
                    "human_assembly_observed": False},
                "supplied_runtime_code_is_free": True, "http_calls": calls, "telegram_sends": 1,
                "body_sha256": hashlib.sha256(body.encode()).hexdigest(), "checks": checks,
                "machine_elapsed_ms": round(sum(row["machine_elapsed_ms"] for row in ledger), 3), "transcript": ledger}, body


def compare():
    modules()
    import build
    bundle = build.build()
    api = Api()
    try:
        cases = []
        for pack in WORKFLOWS:
            baseline, native_text = arm(api, pack, "native", bundle)
            packaged, pack_text = arm(api, pack, "hstack", bundle)
            assert native_text == pack_text, "comparison requires identical report text"
            expected = {"activity-brief": ("/commit/", "/issues/7", "/pull/8"), "review-queue": ("/pull/8", "reviewer"),
                        "release-watch": ("/releases/tag/v1.2.3", "Reliable release")}[pack]
            assert all(value in pack_text for value in expected)
            cases.append({"workflow": pack, "identical_report_body": True, "native": baseline, "hstack": packaged})
        return {"schema_version": 1, "evidence_scope": "reproducible_local_comparison", "cases": cases,
                "native_minimal_alternative": {"scheduled_ai_prompt_create_commands": 1, "executed_here": False,
                    "same_deterministic_outcome": False, "reason": "A native scheduled prompt is simpler; its model behavior is outside this deterministic comparison."},
                "limits": {"human_setup_time_measured": False, "live_hermes": False, "live_github": False, "live_telegram": False,
                    "ssh_transport_in_this_comparison": False, "native_cli": "explicit v0.22.5 fixture", "http": "real loopback HTTP",
                    "excluded_equally": ["Hermes installation", "trusted target access", "credentials acquisition", "runtime implementation"],
                    "native_lifecycle_safety_equivalent": False,
                    "command_count_scope": "Actual process invocations in these supplied transcripts; combining commands or using an agent changes counts.",
                    "machine_timing_scope": "Test process/runtime overhead, not human setup time or real-target speed."}}
    finally:
        api.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--step")
    parser.add_argument("--root", type=Path)
    parser.add_argument("--pack", choices=WORKFLOWS)
    args = parser.parse_args()
    if args.step:
        operation(args.step, args.root, args.pack)
        return
    report = compare()
    raw = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.output:
        if args.output.exists() or args.output.is_symlink():
            raise SystemExit("refusing_existing_comparison_output")
        args.output.write_text(raw)
        args.output.chmod(0o600)
    else:
        print(raw, end="")


if __name__ == "__main__":
    main()
