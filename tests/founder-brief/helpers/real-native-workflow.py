"""Opt-in exact-source Hermes cron integration, with loopback vendors only.

This exercises the upstream parser, handler, store, claim and no-agent subprocess.
It deliberately does not start a gateway or test Linux/systemd readiness, the full
Hermes bootstrap, the managed Python distribution, or real Telegram delivery.
Run with a disposable Python3.14.9 environment containing the upstream dependencies.
No existing Hermes home or credentials are read.
"""
import argparse
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlsplit

COMMIT = "bf0203a794a07aac3ff764972ab9087baa4e4f4e"
PINS = {
    "hermes_cli/cron.py": "ccbfca93948ea67c267ec2dd0abeed9f70eaaa99c35935b63da74d1be2ac9aea",
    "hermes_cli/subcommands/cron.py": "c07a27db9575afd77dfd7e1e0f0051241262706c11998d92f8b26369536f3222",
    "cron/jobs.py": "81c8ee2fde2e351c3d5d9ac02cbc8f0eab2b2bb626ee7524f3754d9e9f5e3848",
    "cron/scheduler.py": "ec5823fffdeb18f4417eb97cbd37a03739c2fc20bb4e44c333d2dd5e07d86dd4",
    "cron/scheduler_script.py": "232e3f8b09ebdfa23ac0f853a8cd4179683458f6e34af1f638867e6130d170d8",
    "cron/scheduler_tick.py": "17eb6231ddca87224e86704d996ddf8e1dbce7985d0985b6f85bdec77dbd23d3",
    "tools/cronjob_tools.py": "99f980bc671e5dc48bd982a8ed0c21fe93b3ab2262f6c723ff6319d8f6910822",
}
REPOSITORY = Path(__file__).resolve().parents[3]
BOT = "123456:FAKE" + "x" * 32
CHAT = "555000111"


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--isolated", action="store_true", help=argparse.SUPPRESS)
    return parser.parse_args()


def check_source(source):
    for relative, expected in PINS.items():
        if hashlib.sha256((source / relative).read_bytes()).hexdigest() != expected:
            raise RuntimeError("upstream_source_pin_mismatch: " + relative)


def isolate(source):
    """All Hermes imports and their children run under an empty private home."""
    with tempfile.TemporaryDirectory(prefix="hstack-real-native-") as directory:
        scratch = Path(directory).resolve()
        env = {
            "HOME": str(scratch), "HERMES_HOME": str(scratch / ".hermes"),
            "PATH": str(Path(sys.executable).parent) + ":/usr/bin:/bin",
            "HERMES_DISABLE_LAZY_INSTALLS": "1", "PYTHONDONTWRITEBYTECODE": "1",
            "LANG": "en_US.UTF-8", "TMPDIR": str(scratch),
        }
        result = subprocess.run([sys.executable, "-I", "-B", str(Path(__file__).resolve()),
                                 "--source", str(source), "--isolated"],
                                env=env, cwd=scratch, capture_output=True, text=True, timeout=180)
        sys.stdout.write(result.stdout)
        sys.stderr.write(result.stderr)
        return result.returncode


def bridge_bytes(source):
    # The real top-level Hermes bootstrap is intentionally excluded: it may
    # activate/download a managed runtime. Only the exact cron command handler
    # and parser are entered; all execution below those is the upstream code.
    return ("#!" + sys.executable + "\n"
            "import argparse, sys\n"
            "sys.path.insert(0, " + repr(str(source)) + ")\n"
            "from hermes_cli.subcommands.cron import build_cron_parser\n"
            "from hermes_cli.cron import cron_command\n"
            "parser = argparse.ArgumentParser()\n"
            "parser.add_argument('--profile', choices=['default'])\n"
            "build_cron_parser(parser.add_subparsers(dest='command'), cmd_cron=cron_command)\n"
            "args = parser.parse_args()\n"
            "raise SystemExit(cron_command(args))\n").encode()


def launcher_bytes(home, runtime, bridge, instance, port):
    # Test-only client injection is part of the reviewed test launcher, never a
    # production URL/config override. The runtime bytes themselves are unchanged.
    return ("import http.client, json, sys\n"
            "sys.path.insert(0, " + repr(str(runtime)) + ")\n"
            "import workflow, deployment\n"
            "collector = workflow.collector_module()\n"
            "github = collector.GitHubClient._for_test('http://127.0.0.1:" + str(port) + "', token='', sleep=lambda _: None)\n"
            "def telegram(method, payload):\n"
            "    connection = http.client.HTTPConnection('127.0.0.1', " + str(port) + ", timeout=3)\n"
            "    try:\n"
            "        connection.request('POST', '/synthetic-bot/' + method, json.dumps(payload), {'Content-Type':'application/json'})\n"
            "        response = connection.getresponse()\n"
            "        return response.status, dict(response.headers), response.read()\n"
            "    finally:\n"
            "        connection.close()\n"
            "dep = deployment.Deployment(" + repr(str(home)) + ", " + repr(str(bridge)) + ", offline=True, instance_id=" + repr(instance) + ")\n"
            "try:\n"
            "    result = workflow.execute(" + repr(str(home)) + ", instance_id=" + repr(instance) + ", _github_client=github, _telegram_client=telegram, _deployment=dep)\n"
            "    print(workflow.safe_summary(result))\n"
            "except Exception:\n"
            "    raise SystemExit(1)\n").encode()


class Vendors:
    def __init__(self):
        self.sends = []
        self.gets = []
        self.outage = False
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, status, value):
                raw = json.dumps(value).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                from datetime import datetime, timezone
                path = urlsplit(self.path).path
                owner.gets.append(path)
                date = datetime.fromtimestamp(time.time() - 60, timezone.utc).isoformat().replace("+00:00", "Z")
                if owner.outage:
                    return self.reply(503, {"message": "synthetic outage"})
                if path.endswith("/commits"):
                    value = [{"sha": "a" * 40, "commit": {"committer": {"date": date}, "message": "Native integration"}}]
                elif path.endswith("/issues"):
                    value = [{"number": 7, "updated_at": date, "state": "open", "title": "Native issue"}]
                elif path.endswith("/pulls"):
                    value = [{"number": 8, "created_at": date, "updated_at": date, "state": "open", "draft": False,
                              "title": "Native PR", "user": {"login": "author"},
                              "requested_reviewers": [{"login": "reviewer"}], "requested_teams": []}]
                elif path.endswith("/releases"):
                    value = [{"id": 9, "published_at": date, "created_at": date, "draft": False,
                              "prerelease": False, "tag_name": "v1.2.3", "name": "Native release"}]
                else:
                    return self.reply(404, {})
                self.reply(200, value)

            def do_POST(self):
                method = self.path.rsplit("/", 1)[-1]
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if method == "getMe":
                    value = {"id": 123456, "is_bot": True}
                elif method == "getChat":
                    value = {"id": int(CHAT), "type": "private"}
                elif method == "sendMessage":
                    owner.sends.append(payload)
                    value = {"message_id": len(owner.sends), "date": int(time.time()),
                             "from": {"id": 123456, "is_bot": True},
                             "chat": {"id": int(CHAT), "type": "private"}, "text": payload["text"]}
                else:
                    return self.reply(404, {})
                self.reply(200, {"ok": True, "result": value})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *unused):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


def exercise(source):
    if sys.version_info[:3] != (3, 14, 9):
        raise RuntimeError("Hermes0.22.5 pinned Python3.14.9 required")
    home = Path(os.environ["HERMES_HOME"])
    home.mkdir(mode=0o700)
    hstack_source = REPOSITORY / "packages/founder-brief"
    sys.path.insert(0, str(hstack_source))
    spec = importlib.util.spec_from_file_location("native_adapter", REPOSITORY / "packages/acceptance/target/native-hermes-v0_22_5.py")
    adapter = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = adapter
    spec.loader.exec_module(adapter)
    import build
    import deployment
    import workflow

    class NativeWithoutService(deployment.Deployment):
        def _ready(self):
            # This test has no live gateway/systemd target. All cron calls after
            # this explicit readiness seam use real, pinned Hermes source.
            pass

    bridge = home.parent / "hermes-cron-native"
    bridge.write_bytes(bridge_bytes(source))
    bridge.chmod(0o700)
    bundle = build.build()
    jobs_path = home / "cron/jobs.json"
    proofs, records = [], []
    with Vendors() as api:
        for index, pack in enumerate(workflow.WORKFLOWS):
            instance = "native-" + pack
            config = {"schema_version": 1, "repositories": ["acme/widget"], "telegram_chat_id": CHAT,
                      "daily_time": "09:00", "timezone": "UTC", "window_hours": 24,
                      "workflow": pack, "instance_id": instance}
            dep = NativeWithoutService(home, str(bridge), offline=True, instance_id=instance)
            runtime = dep.root / "runtime.pyz"
            launcher = launcher_bytes(home, runtime, bridge, instance, api.server.server_port)
            dep.install(bundle, launcher, config, {"GITHUB_TOKEN": "", "TELEGRAM_BOT_TOKEN": BOT})
            record = dep._read_receipt()
            commands = []
            def dispatch(args):
                called = subprocess.run(args, env=dep.native.environment(), capture_output=True, text=True, timeout=120)
                commands.append(called)
                return called.returncode
            try:
                result = workflow.run_canary(home, record["review_hash"], format(index + 1, "032x"),
                                             instance_id=instance, _deployment=dep, _dispatch=dispatch)
            except Exception:
                for called in commands:
                    sys.stderr.write(called.stdout + called.stderr)
                if jobs_path.exists():
                    sys.stderr.write(jobs_path.read_text())
                raise
            assert result["delivery"]["evidence_scope"] == "telegram-api-ack"
            assert result["delivery"]["recipient_read"] is False
            assert len(api.sends) == index + 1
            jobs = json.loads(jobs_path.read_text())["jobs"]
            job = next(row for row in jobs if row["id"] == record["job_id"])
            assert job["last_status"] == "ok", job.get("last_error")
            assert job["repeat"]["completed"] >= 1
            dep.verify_installation(verify_job=True)
            proofs.append(result["delivery"])
            records.append((dep, record, instance))

        assert len(json.loads(jobs_path.read_text())["jobs"]) == 3
        assert len({proof["config_hash"] for proof in proofs}) == 3
        before = (len(api.gets), len(api.sends))
        dep, record, instance = records[0]
        replay = workflow.run_canary(home, record["review_hash"], format(1, "032x"),
                                     instance_id=instance, _deployment=dep)
        assert replay["delivery"] == proofs[0]
        assert (len(api.gets), len(api.sends)) == before
        # Native exit/status must expose a real worker failure. An uncollected
        # report sends nothing; the same armed window recovers when GitHub does.
        api.outage = True
        try:
            workflow.run_canary(home, record["review_hash"], format(4, "032x"),
                                instance_id=instance, _deployment=dep)
            raise AssertionError("outage must fail the native canary")
        except workflow.WorkflowError as error:
            assert str(error) == "native_canary_has_no_matching_api_ack"
        assert len(api.sends) == 3
        failed = next(row for row in json.loads(jobs_path.read_text())["jobs"] if row["id"] == record["job_id"])
        assert failed["last_status"] == "error"
        assert failed["failure_streak"] == 1
        api.outage = False
        recovered = workflow.run_canary(home, record["review_hash"], format(4, "032x"),
                                        instance_id=instance, _deployment=dep)
        assert recovered["delivery"]["evidence_scope"] == "telegram-api-ack"
        assert len(api.sends) == 4

        # Arm via the actual native store API, then fire via the real scheduler
        # tick instead of manual run. No jobs.json edits or scheduler stubs.
        sys.path.insert(0, str(source))
        from cron.jobs import trigger_job
        def dispatch_tick(args):
            trigger_job(args[-1])
            called = subprocess.run([str(bridge), "--profile", "default", "cron", "tick"],
                                    env=dep.native.environment(), capture_output=True, text=True, timeout=120)
            if called.returncode:
                sys.stderr.write(called.stdout + called.stderr)
            return called.returncode
        ticked = workflow.run_canary(home, record["review_hash"], format(5, "032x"),
                                    instance_id=instance, _deployment=dep, _dispatch=dispatch_tick)
        assert ticked["delivery"]["evidence_scope"] == "telegram-api-ack"
        assert len(api.sends) == 5
        for dep, record, instance in records:
            dep.rollback()
        assert json.loads(jobs_path.read_text())["jobs"] == []
        return {"status": "passed", "evidence_scope": "real-native-cron-with-loopback-vendors",
                "upstream_commit": COMMIT, "pinned_source_files": len(PINS), "python": sys.version.split()[0],
                "workflows": list(workflow.WORKFLOWS), "native_jobs": 3, "api_acknowledgements": 5,
                "confirmed_replay_sends": 0, "jobs_after_rollback": 0,
                "native_failure_recovery": True, "native_scheduler_tick": True,
                "live_telegram": False, "linux_systemd_readiness": False,
                "full_hermes_bootstrap": False, "managed_runtime_activation": False,
                "supported_python": sys.version_info[:2] == (3, 14)}


def main():
    args = arguments()
    source = args.source.resolve(strict=True)
    check_source(source)
    if not args.isolated:
        return isolate(source)
    print(json.dumps(exercise(source), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
