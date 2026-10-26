"""Offline deployment checks; the subprocess below is an explicit CLI fixture."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[3]
def module(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    value = importlib.util.module_from_spec(spec)
    sys.modules[name] = value
    spec.loader.exec_module(value)
    return value

native = module("native_adapter", REPO / "packages/acceptance/target/native-hermes-v0_22_5.py")
module("workflow", REPO / "packages/founder-brief/workflow.py")
deployment = module("brief_deployment", REPO / "packages/founder-brief/deployment.py")

FIXTURE = Path(__file__).with_name("native-hermes-v0_22_5.py").read_text()


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hstack-brief-deployment-")
        self.home = Path(self.temp.name).resolve() / ".hermes"
        self.home.mkdir(mode=0o700)
        self.hermes = Path(self.temp.name) / "hermes-fixture"
        self.hermes.write_text(FIXTURE)
        self.hermes.chmod(0o700)
        self.env = patch.dict(os.environ, {"HERMES_HOME": str(self.home)}, clear=False)
        self.env.start()
        for key in ("BRIEF_FAIL", "BRIEF_VERSION", "BRIEF_VERSION_TEXT", "BRIEF_COMMIT"):
            os.environ.pop(key, None)
        self.dep = deployment.Deployment(self.home, self.hermes, offline=True)
        self.config = {"schema_version": 1, "repositories": ["example/project"], "telegram_chat_id": "123456789",
                       "daily_time": "09:00", "timezone": "Asia/Kolkata", "window_hours": 24}
        self.credentials = {"GITHUB_TOKEN": "test_gh_secret_123", "TELEGRAM_BOT_TOKEN": "123456:test_bot_secret_1234567890"}
        self.bundle = b"reviewed zipapp fixture"
        self.launcher = b"#!/usr/bin/env python3\n# reviewed launcher fixture\n"

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def install(self):
        return self.dep.install(self.bundle, self.launcher, self.config, self.credentials)

    def jobs(self):
        file = self.home / "cron/jobs.json"
        return json.loads(file.read_text())["jobs"] if file.exists() else []

    def save_jobs(self, jobs):
        (self.home / "cron").mkdir(exist_ok=True)
        (self.home / "cron/jobs.json").write_text(json.dumps({"jobs": jobs}))

    def calls(self):
        file = self.home / "fixture-argv.jsonl"
        return [json.loads(line) for line in file.read_text().splitlines()] if file.exists() else []

    def assert_code(self, code, call):
        with self.assertRaises(deployment.DeploymentError) as raised:
            call()
        self.assertEqual(raised.exception.code, code)

    def test_install_is_private_native_and_identical_install_is_unchanged(self):
        result = self.install()
        self.assertEqual(result["status"], "installed")
        job = self.jobs()[0]
        self.assertTrue(job["no_agent"])
        self.assertEqual((job["deliver"], job["failure_deliver"], job["script"]), ("local", "local", deployment.SCRIPT))
        receipt = self.dep._read_receipt()
        self.assertEqual(receipt["job_id"], job["id"])
        self.assertTrue(receipt["installed_at"].endswith("+00:00"))
        for key, path in self.dep._paths().items():
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700 if key == "launcher" else 0o600)
        before = {path: path.read_bytes() for path in self.dep._paths().values()}
        self.assertEqual(self.install()["status"], "unchanged")
        self.assertEqual(before, {path: path.read_bytes() for path in self.dep._paths().values()})
        self.assertEqual(len([args for args in self.calls() if "create" in args]), 1)
        self.assertFalse(any(any(value in {"stop", "start", "restart", "set"} for value in args) for args in self.calls()))
        self.assertFalse(any(secret in json.dumps(self.calls()) for secret in self.credentials.values()))

    def test_changed_plan_or_credentials_requires_review(self):
        self.install()
        self.config["daily_time"] = "10:00"
        self.assert_code("existing_plan_requires_review", self.install)
        self.config["daily_time"] = "09:00"
        self.credentials["GITHUB_TOKEN"] = "changed_secret"
        self.assert_code("existing_plan_requires_review", self.install)
        self.assertEqual(len(self.jobs()), 1)

    def test_create_failure_cleans_only_owned_payload_and_retains_receipt(self):
        foreign = {"id": "foreign", "name": "foreign", "prompt": "foreign", "schedule": {"kind": "cron", "expr": "0 2 * * *"}, "repeat": {"times": None}}
        self.save_jobs([foreign])
        os.environ["BRIEF_FAIL"] = "create_before"
        self.assert_code("install_failed_cleaned", self.install)
        self.assertEqual(self.jobs(), [foreign])
        self.assertTrue(all(not path.exists() for path in self.dep._paths().values()))
        self.assertEqual(self.dep._read_receipt()["phase"], "rolled_back")

    def test_lost_create_and_remove_replies_are_reconciled_by_exact_job(self):
        os.environ["BRIEF_FAIL"] = "create_after"
        self.assertEqual(self.install()["status"], "installed")
        self.assertEqual(len(self.jobs()), 1)
        os.environ["BRIEF_FAIL"] = "remove_after"
        self.assertEqual(self.dep.rollback()["status"], "rolled_back")
        self.assertEqual(self.jobs(), [])

    def test_interrupted_publication_resumes_only_matching_bytes(self):
        original = self.dep._atomic
        def interrupted(path, data, mode, **kwargs):
            if path.name == "runtime.pyz":
                raise KeyboardInterrupt()
            return original(path, data, mode, **kwargs)
        with patch.object(self.dep, "_atomic", side_effect=interrupted):
            with self.assertRaises(KeyboardInterrupt):
                self.install()
        installed_at = self.dep._read_receipt()["installed_at"]
        self.assertTrue(self.dep.launcher.exists())
        self.assertEqual(self.install()["status"], "installed")
        self.assertEqual(self.dep._read_receipt()["installed_at"], installed_at)
        self.assertEqual(len(self.jobs()), 1)

    def test_interrupted_create_reconciles_without_duplicate_creation(self):
        original = self.dep._run
        def interrupted(args, **kwargs):
            result = original(args, **kwargs)
            if "create" in args:
                raise KeyboardInterrupt()
            return result
        with patch.object(self.dep, "_run", side_effect=interrupted):
            with self.assertRaises(KeyboardInterrupt):
                self.install()
        self.assertEqual(len(self.jobs()), 1)
        self.assertEqual(self.install()["status"], "installed")
        self.assertEqual(len([args for args in self.calls() if "create" in args]), 1)

    def test_rollback_preserves_unrelated_jobs_user_files_and_runtime_evidence(self):
        self.install()
        foreign = {"id": "foreign", "name": "foreign", "prompt": "foreign", "schedule": {"kind": "cron", "expr": "0 2 * * *"}, "repeat": {"times": None}}
        self.save_jobs(self.jobs() + [foreign])
        evidence = self.dep.root / "state/delivery.json"
        evidence.write_text('{"message_id":123}')
        other = self.dep.scripts / "other.py"
        other.write_text("operator bytes")
        self.assertEqual(self.dep.rollback()["status"], "rolled_back")
        self.assertEqual(self.jobs(), [foreign])
        self.assertTrue(all(not path.exists() for path in self.dep._paths().values()))
        self.assertEqual(evidence.read_text(), '{"message_id":123}')
        self.assertEqual(other.read_text(), "operator bytes")
        self.assertEqual(self.dep.rollback()["status"], "already_rolled_back")

    def test_file_or_job_drift_refuses_rollback_without_removing_anything(self):
        self.install()
        runtime = self.dep.root / "runtime.pyz"
        runtime.write_bytes(b"operator changed runtime")
        self.assert_code("owned_file_drift", self.dep.rollback)
        self.assertEqual(len(self.jobs()), 1)
        self.assertTrue((self.dep.root / "credentials.json").exists())
        runtime.write_bytes(self.bundle)
        jobs = self.jobs();jobs[0]["prompt"] = "operator changed marker"
        self.save_jobs(jobs)
        self.assert_code("native_job_drift", self.dep.rollback)
        self.assertTrue(runtime.exists())

    def test_failed_remove_retains_credentials_and_complete_recovery_point(self):
        self.install()
        os.environ["BRIEF_FAIL"] = "remove_before"
        self.assert_code("native_remove_unconfirmed", self.dep.rollback)
        self.assertTrue(all(path.exists() for path in self.dep._paths().values()))
        self.assertEqual(self.dep._read_receipt()["phase"], "complete")

    def test_existing_unmanaged_files_and_prior_owned_markers_are_refused(self):
        self.dep.scripts.mkdir()
        self.dep.launcher.write_bytes(b"operator launcher")
        self.assert_code("existing_workflow_requires_review", self.install)
        self.assertEqual(self.dep.launcher.read_bytes(), b"operator launcher")
        self.dep.launcher.unlink()
        job = dict(deployment.desired_job(), id="prior-owned")
        self.save_jobs([job])
        self.assert_code("existing_workflow_requires_review", self.install)

    def test_runtime_and_shared_profile_mismatches_refuse_before_payload_publication(self):
        for key, value, code in (("BRIEF_VERSION", "0.21.0", "native_version_mismatch"), ("BRIEF_COMMIT", "wrong", "native_readiness_mismatch")):
            os.environ[key] = value
            self.assert_code(code, self.install)
            os.environ.pop(key)
            self.assertFalse(self.dep.root.exists())
        (self.home / "profiles").mkdir();(self.home / "profiles/coder").mkdir()
        self.assert_code("native_scope_refused", self.install)
        self.assertFalse(self.dep.root.exists())

    def test_version_is_read_from_the_banner_of_real_multiline_output_and_compared_exactly(self):
        # Real v0.22.5 output (hermes_cli/_startup_fast.py print_fast_version_info) also prints the release
        # date, the Python version and the OpenAI SDK version, each shaped like x.y.z.
        real = ("Hermes Agent v0.22.5 (2026.9.24) \u00b7 upstream bf0203a7\nInstall directory: /srv/hermes\n"
                "Install method: git\nPython: 3.11.16\nOpenAI SDK: 2.24.0\n")
        for text in (real, "Hermes Agent v0.22.5\n", "Hermes Agent v0.22.5 (2026.9.24)\nPython: 3.11.16\n",
                     "Hermes Agent v0.22.5 \u00b7 stable\nPython: 3.11.16\n"):
            os.environ["BRIEF_VERSION_TEXT"] = text
            self.dep._ready()
        for text in (
            real.replace("v0.22.5", "v0.22.4"),                 # other release; 0.22.5 absent from the banner
            real.replace("v0.22.5 (", "v0.22.5+3.gabc1234 ("),   # derived dev build of 0.22.5 is not 0.22.5
            real.replace("v0.22.5 (", "v0.22.5.1 ("),
            "Hermes Agent v0.21.0 (2026.8.31)\nPython: 0.22.5\n",  # a later line must never satisfy the check
            "Python: 0.22.5\nHermes Agent v0.22.5 (2026.9.24)\n",  # only the first line is the banner
            "0.22.5\n", "hermes 0.22.5\n", "", "\n",
        ):
            os.environ["BRIEF_VERSION_TEXT"] = text
            self.assert_code("native_version_mismatch", self.dep._ready)

    def test_unexpected_credentials_or_invalid_config_refuse_without_cli_calls(self):
        self.credentials["EXTRA_TOKEN"] = "private"
        self.assert_code("invalid_credentials", self.install)
        self.assertEqual(self.calls(), [])
        self.credentials.pop("EXTRA_TOKEN")
        self.config["telegram_chat_id"] = "-123"
        self.assert_code("invalid_config", self.install)
        self.assertEqual(self.calls(), [])

    def test_guard_verifies_bytes_and_blocks_rollback_through_send_without_cli_calls(self):
        self.install()
        calls = self.calls()
        other = deployment.Deployment(self.home, self.hermes, offline=True)
        with self.dep.runtime_guard() as receipt:
            self.assertEqual(receipt["hermes"], str(self.hermes))
            self.assertEqual(receipt["phase"], "complete")
            self.assertEqual(self.dep.verify_installation()["job_id"], receipt["job_id"])
            self.assert_code("deployment_busy", other.rollback)
        self.assertEqual(self.calls(), calls)
        (self.dep.root / "runtime.pyz").write_bytes(b"operator replacement")
        with self.assertRaises(deployment.DeploymentError) as raised:
            with self.dep.runtime_guard():
                self.fail("a worker must not send with changed runtime bytes")
        self.assertEqual(raised.exception.code, "owned_file_drift")
        self.assertEqual(self.calls(), calls)

    def test_kernel_lock_releases_after_owner_is_killed(self):
        self.dep.parent.mkdir(mode=0o700)
        lock = self.dep.parent / "founder-brief.lock"
        lock.touch(mode=0o600)
        script = "import fcntl,sys,time;f=open(sys.argv[1],'r+');fcntl.flock(f,fcntl.LOCK_EX);print('locked',flush=True);time.sleep(120)"
        child = subprocess.Popen([sys.executable, "-I", "-B", "-c", script, str(lock)], stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), "locked")
            self.assert_code("deployment_busy", self.install)
        finally:
            child.kill()
            child.wait(timeout=5)
            child.stdout.close()
        self.assertTrue(lock.exists(), "persistent inode is retained, kernel ownership is released")
        self.assertEqual(self.install()["status"], "installed")

    def test_cleanup_refuses_operator_edits_and_preserves_the_recovery_receipt(self):
        original = self.dep._run
        def failed_create(args, **kwargs):
            if "create" in args:
                (self.dep.root / "runtime.pyz").write_bytes(b"operator bytes during install")
                raise deployment.DeploymentError("native_cli_unconfirmed")
            return original(args, **kwargs)
        with patch.object(self.dep, "_run", side_effect=failed_create):
            self.assert_code("install_cleanup_requires_review", self.install)
        self.assertEqual((self.dep.root / "runtime.pyz").read_bytes(), b"operator bytes during install")
        self.assertTrue((self.dep.root / "credentials.json").exists())
        self.assertEqual(self.dep._read_receipt()["phase"], "create_intended")
        self.assertEqual(self.jobs(), [])

    def test_public_repo_credentials_and_review_canonicalization_match_workflow(self):
        self.credentials.pop("GITHUB_TOKEN")
        self.config["repositories"] = ["Zeta/Project", "Example/App"]
        review = self.dep.review_descriptor(self.bundle, self.launcher, self.config)
        self.assertEqual(review["config"]["repositories"], ["example/app", "zeta/project"])
        self.assertEqual(self.install()["status"], "installed")
        self.assertEqual(json.loads((self.dep.root / "credentials.json").read_text())["GITHUB_TOKEN"], "")


if __name__ == "__main__":
    unittest.main()
