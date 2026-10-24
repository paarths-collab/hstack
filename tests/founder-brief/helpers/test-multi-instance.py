"""Named workflows through installed zipapps, native CLI children and loopback HTTP.

The native scheduler and vendor APIs are declared fixtures. Each native run selects
the job's actual installed launcher, executes its bytes and follows its execv
arguments into its own installed runtime. Only test HTTP clients and Linux service
readiness are substituted; no production endpoint override is installed.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import runpy
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit

REPO = Path(__file__).resolve().parents[3]
SOURCE = REPO / "packages/founder-brief"
BOT = "123456:FAKE" + "x" * 32
GITHUB = "ghp_FAKE" + "x" * 32
CREDENTIALS = {"GITHUB_TOKEN": GITHUB, "TELEGRAM_BOT_TOKEN": BOT}
CONFIG = {"schema_version": 1, "repositories": ["acme/widget"], "telegram_chat_id": "555000111",
          "daily_time": "09:00", "timezone": "UTC", "window_hours": 24}


def telegram_client(port):
    def request(method, payload):
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        try:
            connection.request("POST", "/synthetic-bot/" + method, json.dumps(payload),
                               {"Content-Type": "application/json"})
            response = connection.getresponse()
            return response.status, dict(response.headers), response.read()
        finally:
            connection.close()
    return request


def installed_worker(launcher):
    """Intercept the launcher's execv only after executing the installed bytes."""
    launcher = Path(launcher).resolve()
    port = int(os.environ["HSTACK_MULTI_TEST_HTTP_PORT"])
    if not 1 <= port <= 65535:
        raise RuntimeError("invalid_test_port")

    def launch(executable, argv):
        if argv[:3] != [sys.executable, "-I", "-B"] or executable != sys.executable:
            raise RuntimeError("unexpected_installed_launcher_arguments")
        runtime = Path(argv[3]).resolve()
        sys.path.insert(0, str(runtime))
        import deployment
        import github_brief
        import telegram_delivery
        import workflow
        if not str(workflow.__file__).startswith(str(runtime) + "/"):
            raise RuntimeError("worker_did_not_load_installed_runtime")
        original_deployment = deployment.Deployment
        original_github = github_brief.GitHubClient
        original_telegram = telegram_delivery.TelegramDelivery

        class OfflineDeployment(original_deployment):
            def __init__(self, *args, **kwargs):
                kwargs["offline"] = True
                super().__init__(*args, **kwargs)

        class HttpTelegram(original_telegram):
            def __init__(self, *args, **kwargs):
                kwargs["_client"] = telegram_client(port)
                super().__init__(*args, **kwargs)

        def github_factory(token=""):
            return original_github._for_test("http://127.0.0.1:" + str(port), token=token, sleep=lambda _: None)

        # Native cron arguments select the job, the installed launcher selects
        # its runtime and --instance, then the production CLI selects its files.
        trace = Path(os.environ["HERMES_HOME"]) / "multi-dispatch.jsonl"
        with trace.open("a") as handle:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX)
            handle.write(json.dumps({"launcher": str(launcher), "runtime": str(runtime), "args": argv[4:]}) + "\n")
        with patch.object(deployment, "Deployment", OfflineDeployment), \
                patch.object(github_brief, "GitHubClient", github_factory), \
                patch.object(telegram_delivery, "TelegramDelivery", HttpTelegram), \
                patch.object(sys, "argv", [str(runtime)] + argv[4:]):
            raise SystemExit(workflow.main(argv[4:]))

    with patch.object(os, "execv", launch):
        runpy.run_path(str(launcher), run_name="__main__")
    raise RuntimeError("installed_launcher_did_not_dispatch")


if len(sys.argv) > 1 and sys.argv[1] == "--worker":
    installed_worker(sys.argv[2])
    raise SystemExit(0)

sys.path.insert(0, str(SOURCE))
spec = importlib.util.spec_from_file_location("native_adapter", REPO / "packages/acceptance/target/native-hermes-v0_22_5.py")
native = importlib.util.module_from_spec(spec)
sys.modules["native_adapter"] = native
spec.loader.exec_module(native)
spec = importlib.util.spec_from_file_location("github_brief", SOURCE / "github-brief.py")
github_brief = importlib.util.module_from_spec(spec)
sys.modules["github_brief"] = github_brief
spec.loader.exec_module(github_brief)
import build
import deployment
import workflow
import telegram_delivery


class Api:
    def __init__(self):
        self.calls, self.sends = [], []
        self.failed_repositories, self.lost_ack_chats = set(), set()
        self.lock = threading.Lock()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def answer(self, status, value):
                raw = json.dumps(value).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                path = urlsplit(self.path).path
                with owner.lock:
                    owner.calls.append(("GET", path))
                repository = "/".join(path.split("/")[2:4])
                if repository in owner.failed_repositories:
                    self.answer(503, {"message": BOT + GITHUB})
                    return
                date = (datetime.now(timezone.utc) - timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
                if path.endswith("/commits"):
                    result = [{"sha": "a" * 40, "commit": {"committer": {"date": date},
                               "message": "A useful change for " + repository}}]
                elif path.endswith("/issues"):
                    result = [{"number": 7, "updated_at": date, "state": "open", "title": "Track " + repository}]
                elif path.endswith("/pulls"):
                    result = [{"number": 8, "created_at": "2026-09-01T08:00:00Z", "updated_at": date,
                               "state": "open", "draft": False, "title": "Review " + repository,
                               "user": {"login": "author"}, "requested_reviewers": [{"login": "reviewer"}],
                               "requested_teams": []}]
                elif path.endswith("/releases"):
                    result = [{"id": 9, "draft": False, "prerelease": False, "tag_name": "v1.2.3",
                               "name": "Release " + repository, "published_at": date}]
                else:
                    self.answer(404, {})
                    return
                self.answer(200, result)

            def do_POST(self):
                method = self.path.rsplit("/", 1)[-1]
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                with owner.lock:
                    owner.calls.append(("POST", method))
                if method == "getMe":
                    result = {"id": 123456, "is_bot": True}
                elif method == "getChat":
                    result = {"id": int(payload["chat_id"]), "type": "private"}
                elif method == "sendMessage":
                    with owner.lock:
                        owner.sends.append(payload)
                        message_id = len(owner.sends)
                    if str(payload["chat_id"]) in owner.lost_ack_chats:
                        self.connection.shutdown(socket.SHUT_RDWR)
                        self.connection.close()
                        return
                    result = {"message_id": message_id, "date": int(time.time()),
                              "from": {"id": 123456, "is_bot": True},
                              "chat": {"id": int(payload["chat_id"]), "type": "private"}, "text": payload["text"]}
                else:
                    self.answer(404, {})
                    return
                self.answer(200, {"ok": True, "result": result})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


class MultiInstanceTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="hstack-multi-workflow-")
        self.home = (Path(self.scratch.name) / ".hermes").resolve()
        self.home.mkdir(mode=0o700)
        self.bundle = build.build()
        self.runtime = Path(self.scratch.name) / "runtime.pyz"
        self.runtime.write_bytes(self.bundle)
        self.runtime.chmod(0o600)
        self.hermes = Path(self.scratch.name) / "hermes-fixture"
        fixture = Path(__file__).with_name("native-hermes-v0_22_5.py").read_text()
        hook = '''elif args[1]=="run":
 import subprocess
 selected=[job for job in data["jobs"] if job["id"]==args[2]]
 if len(selected)!=1 or not selected[0]["no_agent"]:sys.exit(94)
 script=home/"scripts"/selected[0]["script"]
 raise SystemExit(subprocess.run([sys.executable,"-I","-B",%s,"--worker",str(script)],check=False).returncode)
else:sys.exit(92)''' % repr(str(Path(__file__).resolve()))
        self.assertEqual(fixture.count("else:sys.exit(92)"), 1)
        self.hermes.write_text(fixture.replace("else:sys.exit(92)", hook))
        self.hermes.chmod(0o700)
        self.api = Api()
        self.environment = patch.dict(os.environ, {"HSTACK_MULTI_TEST_HTTP_PORT": str(self.api.server.server_port)})
        self.environment.start()
        self.configs, self.deployments, self.results = {}, {}, {}

    def tearDown(self):
        self.environment.stop()
        self.api.close()
        self.scratch.cleanup()

    def config(self, instance, pack="activity-brief", **changes):
        return workflow.validate_config({**CONFIG, "instance_id": instance, "workflow": pack, **changes})

    def install(self, instance, config=None):
        config = config or self.config(instance)
        dep = deployment.Deployment(self.home, self.hermes, instance_id=instance, offline=True)
        result = dep.install(self.bundle, workflow.launcher_for(instance), config, CREDENTIALS)
        self.configs[instance], self.deployments[instance], self.results[instance] = config, dep, result
        return result

    def canary(self, instance, canary_id="a" * 32, approval=None):
        dep = self.deployments[instance]
        return workflow.run_canary(self.home, approval or self.results[instance]["review_hash"], canary_id,
                                   instance_id=instance, _deployment=dep)

    def execute(self, instance, **kwargs):
        client = workflow.collector_module().GitHubClient._for_test(
            "http://127.0.0.1:" + str(self.api.server.server_port), token=GITHUB, sleep=lambda _: None)
        return workflow.execute(self.home, instance_id=instance, _deployment=self.deployments[instance],
                                _github_client=client, _telegram_client=telegram_client(self.api.server.server_port), **kwargs)

    def jobs(self):
        return json.loads((self.home / "cron/jobs.json").read_text())["jobs"]

    def traces(self):
        path = self.home / "multi-dispatch.jsonl"
        return [json.loads(row) for row in path.read_text().splitlines()] if path.exists() else []

    def test_three_packs_coexist_and_native_children_follow_each_installed_launcher(self):
        names = ["activity-brief", "review-queue", "release-watch"]
        configurations = [self.config(name, name, repositories=["acme/" + name],
                                     telegram_chat_id=str(555000111 + index)) for index, name in enumerate(names)]
        with ThreadPoolExecutor(max_workers=3) as pool:
            installed = list(pool.map(lambda pair: self.install(*pair), zip(names, configurations)))
        self.assertEqual(len({row["job_id"] for row in installed}), 3)
        self.assertEqual(len(self.jobs()), 3)
        with ThreadPoolExecutor(max_workers=3) as pool:
            proofs = list(pool.map(self.canary, names))
        self.assertEqual(len(self.api.sends), 3)
        self.assertEqual(len({proof["delivery"]["run_id"] for proof in proofs}), 3)
        self.assertEqual({row["delivery"]["window_id"] for row in proofs}, {"canary:" + "a" * 32})
        self.assertTrue(all(row["delivery"]["evidence_scope"] == "telegram-api-ack" for row in proofs))
        self.assertTrue(all(row["delivery"]["recipient_read"] is False for row in proofs))
        expected_gets = {"/repos/acme/activity-brief/commits", "/repos/acme/activity-brief/issues",
                         "/repos/acme/activity-brief/pulls", "/repos/acme/review-queue/pulls",
                         "/repos/acme/release-watch/releases"}
        self.assertEqual({path for method, path in self.api.calls if method == "GET"}, expected_gets)
        trace = self.traces()
        self.assertEqual(len(trace), 3)
        for item in trace:
            instance = item["args"][item["args"].index("--instance") + 1]
            self.assertEqual(Path(item["runtime"]), self.home / ".hstack/workflows" / instance / "runtime.pyz")
            self.assertEqual(Path(item["launcher"]), self.home / "scripts" / ("hstack-workflow-" + instance + ".py"))
        before = list(self.api.calls)
        for name, proof in zip(names, proofs):
            self.assertEqual(self.canary(name), proof)
        self.assertEqual(self.api.calls, before, "replaying one ID must not recollect or resend any instance")
        inventory_before = {str(path.relative_to(self.home)) for path in self.home.rglob("*")}
        native_calls = (self.home / "fixture-argv.jsonl").read_bytes()
        found = subprocess.run([sys.executable, "-I", "-B", str(self.runtime), "list", "--home", str(self.home)],
                               capture_output=True, text=True, check=False)
        self.assertEqual(found.returncode, 0, found.stderr)
        listing = json.loads(found.stdout)
        self.assertEqual({item["instance_id"] for item in listing["instances"]}, set(names))
        status = subprocess.run([sys.executable, "-I", "-B", str(self.runtime), "status", "--home", str(self.home),
                                 "--instance", names[0]], capture_output=True, text=True, check=False)
        self.assertEqual(status.returncode, 0, status.stderr)
        selected = json.loads(status.stdout)
        self.assertEqual(selected["instance_id"], names[0])
        self.assertEqual(selected["job_id"], self.results[names[0]]["job_id"])
        self.assertEqual(selected["phase"], "complete")
        self.assertEqual((self.home / "fixture-argv.jsonl").read_bytes(), native_calls,
                         "metadata inventory/status must not invoke native Hermes")
        self.assertEqual({str(path.relative_to(self.home)) for path in self.home.rglob("*")}, inventory_before,
                         "metadata inventory/status must not create files or directories")

    def test_same_pack_twice_uses_its_own_repository_destination_and_daily_cutoff(self):
        self.install("team-a", self.config("team-a", repositories=["acme/alpha"], daily_time="08:00"))
        self.install("team-b", self.config("team-b", repositories=["acme/beta"], daily_time="09:00",
                                          timezone="Asia/Kolkata", telegram_chat_id="555000222"))
        a, b = self.canary("team-a"), self.canary("team-b")
        self.assertNotEqual(a["delivery"]["destination_fp"], b["delivery"]["destination_fp"])
        by_chat = {str(item["chat_id"]): item["text"] for item in self.api.sends}
        self.assertIn("acme/alpha", by_chat["555000111"])
        self.assertNotIn("acme/beta", by_chat["555000111"])
        self.assertIn("acme/beta", by_chat["555000222"])
        now = datetime.now(timezone.utc) + timedelta(days=2)
        daily_a = self.execute("team-a", now=now)
        daily_b = self.execute("team-b", now=now)
        self.assertNotEqual(workflow.reporting_window(self.configs["team-a"], now)["end"],
                            workflow.reporting_window(self.configs["team-b"], now)["end"])
        self.assertTrue(daily_a["window_id"].startswith("daily:"))
        self.assertTrue(daily_b["window_id"].startswith("daily:"))
        self.assertEqual(len(self.api.sends), 4)

    def test_rollback_one_preserves_other_workflows_and_unrelated_user_content(self):
        self.install("first")
        self.install("middle", self.config("middle", "review-queue"))
        self.install("last", self.config("last", "release-watch"))
        store = self.home / "cron/jobs.json"
        state = json.loads(store.read_text())
        unrelated = dict(state["jobs"][0], id="user-owned", name="User task", script="user-task.py", prompt="User prompt")
        state["jobs"].append(unrelated)
        store.write_text(json.dumps(state))
        user_script = self.home / "scripts/user-task.py"
        user_script.write_text("# Keep this user-owned file\n")
        self.assertEqual(self.canary("middle")["delivery"]["status"], "confirmed")
        dep = self.deployments["middle"]
        self.assertEqual(dep.rollback()["status"], "rolled_back")
        self.assertEqual(dep.rollback()["status"], "already_rolled_back")
        self.assertFalse(dep.launcher.exists())
        self.assertFalse((dep.root / "credentials.json").exists())
        self.assertTrue((dep.root / "state").is_dir(), "rollback retains only that instance's delivery evidence")
        self.assertIn(unrelated, self.jobs())
        self.assertEqual(user_script.read_text(), "# Keep this user-owned file\n")
        self.canary("first")
        self.canary("last")
        self.install("replacement", self.config("replacement", "review-queue"))
        self.assertEqual(len({job["id"] for job in self.jobs()}), len(self.jobs()))
        self.canary("replacement")
        self.assertEqual(len(self.api.sends), 4)

    def test_other_instances_approval_or_deployment_cannot_select_this_instances_files(self):
        self.install("one")
        self.install("two")
        self.assertNotEqual(self.results["one"]["review_hash"], self.results["two"]["review_hash"])
        with self.assertRaisesRegex(workflow.WorkflowError, "approval_hash_mismatch"):
            self.canary("one", approval=self.results["two"]["review_hash"])
        with self.assertRaises(workflow.WorkflowError):
            workflow.execute(self.home, instance_id="one", _deployment=self.deployments["two"])
        self.assertEqual(self.api.calls, [])
        self.assertEqual(self.traces(), [])
        wrong = self.config("two")
        with self.assertRaises(deployment.DeploymentError):
            self.deployments["one"].install(self.bundle, workflow.launcher_for("one"), wrong, CREDENTIALS)
        receipt = self.deployments["one"].receipt
        original = receipt.read_bytes()
        receipt.write_bytes(self.deployments["two"].receipt.read_bytes())
        with self.assertRaisesRegex(deployment.DeploymentError, "receipt_drift"):
            self.deployments["one"].verify_installation(verify_job=True)
        receipt.write_bytes(original)
        self.canary("two")
        self.assertEqual(len(self.api.sends), 1)

    def test_one_changed_payload_refuses_before_http_and_other_instance_still_sends(self):
        self.install("broken")
        self.install("healthy")
        runtime = self.deployments["broken"].root / "runtime.pyz"
        runtime.write_bytes(runtime.read_bytes() + b"drift")
        with self.assertRaisesRegex(deployment.DeploymentError, "owned_file_drift"):
            self.canary("broken")
        self.assertEqual(self.api.calls, [])
        self.canary("healthy")
        self.assertEqual(len(self.api.sends), 1)
        with self.assertRaisesRegex(deployment.DeploymentError, "owned_file_drift"):
            self.deployments["broken"].rollback()
        self.assertEqual(self.deployments["healthy"].verify_installation(verify_job=True)["phase"], "complete")

    def test_one_incomplete_collection_does_not_block_a_different_instance(self):
        self.install("unavailable", self.config("unavailable", repositories=["acme/unavailable"]))
        self.install("available", self.config("available", "release-watch", repositories=["acme/available"]))
        self.api.failed_repositories.add("acme/unavailable")
        with self.assertRaisesRegex(workflow.WorkflowError, "github_collection_incomplete"):
            self.execute("unavailable", canary_id="b" * 32)
        self.assertFalse(any(method == "POST" for method, path in self.api.calls))
        self.canary("available")
        self.assertEqual(len(self.api.sends), 1)
        self.api.failed_repositories.clear()
        self.execute("unavailable", canary_id="b" * 32)
        self.assertEqual(len(self.api.sends), 2)

    def test_ambiguous_delivery_stays_local_and_never_resends_while_another_instance_runs(self):
        self.install("unknown")
        self.install("confirmed", self.config("confirmed", "review-queue", telegram_chat_id="555000222"))
        self.api.lost_ack_chats.add("555000111")
        with self.assertRaises(telegram_delivery.DeliveryUnknown):
            self.execute("unknown", canary_id="c" * 32)
        self.assertEqual(len(self.api.sends), 1)
        calls = list(self.api.calls)
        with self.assertRaises(telegram_delivery.DeliveryUnknown):
            self.execute("unknown", canary_id="c" * 32)
        self.assertEqual(self.api.calls, calls)
        self.canary("confirmed", canary_id="c" * 32)
        self.assertEqual(len(self.api.sends), 2)
        self.assertEqual(self.deployments["confirmed"].verify_installation(verify_job=True)["phase"], "complete")

    def test_legacy_and_named_installations_coexist_and_locks_do_not_cross_instances(self):
        parent = self.home / ".hstack"
        absent = Path(self.scratch.name) / "absent-workflow-parent"
        parent.symlink_to(absent, target_is_directory=True)
        with self.assertRaisesRegex(workflow.WorkflowError, "unsafe_workflow_inventory"):
            workflow.list_instances(self.home)
        self.assertFalse(absent.exists())
        self.assertFalse((self.home / "fixture-argv.jsonl").exists())
        parent.unlink()
        legacy = deployment.Deployment(self.home, self.hermes, offline=True)
        legacy_result = legacy.install(self.bundle, workflow.LAUNCHER, CONFIG, CREDENTIALS)
        self.deployments[None], self.results[None], self.configs[None] = legacy, legacy_result, CONFIG
        self.install("named")
        self.assertNotEqual(legacy.root, self.deployments["named"].root)
        with legacy.runtime_guard():
            self.canary("named")
            other_legacy = deployment.Deployment(self.home, self.hermes, offline=True)
            with self.assertRaises(deployment.DeploymentError):
                other_legacy.verify_installation()
        self.canary(None)
        self.assertEqual(len(self.api.sends), 2)
        self.assertTrue(legacy.launcher.exists())
        self.assertTrue(self.deployments["named"].launcher.exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
