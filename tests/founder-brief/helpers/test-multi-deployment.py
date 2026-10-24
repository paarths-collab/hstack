"""Independent deployment namespaces, tested with an explicit native CLI fixture."""
from concurrent.futures import ThreadPoolExecutor
import copy
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
from types import SimpleNamespace
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
scope_for = deployment.scope_for
FIXTURE = Path(__file__).with_name("multi-native-hermes-v0_22_5.py").read_bytes()


class MultiDeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hstack-multi-deployment-")
        self.home = Path(self.temp.name).resolve() / ".hermes"
        self.home.mkdir(mode=0o700)
        self.hermes = Path(self.temp.name) / "hermes-fixture"
        self.hermes.write_bytes(FIXTURE)
        self.hermes.chmod(0o700)
        self.env = patch.dict(os.environ, {"HERMES_HOME": str(self.home)}, clear=False)
        self.env.start()
        os.environ.pop("BRIEF_FAIL_INSTANCE", None)
        self.bundle = b"reviewed multi-workflow runtime fixture"
        self.credentials = {"GITHUB_TOKEN": "", "TELEGRAM_BOT_TOKEN": "123456:test_bot_secret_1234567890"}

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def dep(self, instance_id=None):
        return deployment.Deployment(self.home, self.hermes, offline=True, instance_id=instance_id)

    def config(self, instance_id=None, workflow="activity-brief"):
        value = {"schema_version": 1, "repositories": ["example/project"], "telegram_chat_id": "123456789",
                 "daily_time": "09:00", "timezone": "Asia/Kolkata", "window_hours": 24}
        if workflow != "activity-brief":
            value["workflow"] = workflow
        if instance_id is not None:
            value["instance_id"] = instance_id
        return value

    def launcher(self, instance_id=None):
        return ("# reviewed launcher for " + str(instance_id) + "\n").encode()

    def install(self, dep, workflow="activity-brief"):
        return dep.install(self.bundle, self.launcher(dep.instance_id), self.config(dep.instance_id, workflow), self.credentials)

    def jobs(self):
        store = self.home / "cron/jobs.json"
        return json.loads(store.read_text())["jobs"] if store.exists() else []

    def save_jobs(self, jobs):
        (self.home / "cron/jobs.json").write_text(json.dumps({"jobs": jobs}))

    def assert_code(self, code, call):
        with self.assertRaises(deployment.DeploymentError) as raised:
            call()
        self.assertEqual(raised.exception.code, code)

    def test_scopes_are_immutable_and_legacy_names_are_exact(self):
        scope = scope_for()
        self.assertEqual((scope.instance_id, scope.relative_root, scope.managed_id, scope.marker,
                          scope.script, scope.owner, scope.lock_name),
                         (None, ".hstack/founder-brief", "founder-brief", "[hstack:founder-brief]",
                          "hstack-founder-brief.py", "hstack-founder-brief-v1", "founder-brief.lock"))
        with self.assertRaises(AttributeError):
            scope.instance_id = "changed"
        named = scope_for("team-a")
        self.assertEqual((named.relative_root, named.managed_id, named.marker, named.script, named.owner, named.lock_name),
                         (".hstack/workflows/team-a", "workflow-team-a", "[hstack:workflow-team-a]",
                          "hstack-workflow-team-a.py", "hstack-workflow-v1:team-a", "workflow-team-a.lock"))

    def test_invalid_explicit_names_refuse_before_files_are_created(self):
        for value in ("", "A", "-a", "../other", "a/b", "a b", "a_", "a\n", "é", "a" * 41, 1, False, [], {}):
            with self.subTest(value=repr(value)), self.assertRaisesRegex(ValueError, "invalid_instance_id"):
                self.dep(value)
        self.assertFalse((self.home / ".hstack").exists())
        self.assertEqual(scope_for("a" * 40).instance_id, "a" * 40)

    def test_legacy_review_descriptor_remains_byte_compatible(self):
        dep = self.dep()
        expected = {"schema_version": 1, "workflow": deployment.OWNER, "home": str(self.home), "hermes": str(self.hermes),
                    "hermes_version": deployment.VERSION, "hermes_commit": deployment.COMMIT,
                    "runtime_sha256": deployment.sha(self.bundle), "launcher_sha256": deployment.sha(self.launcher()),
                    "config": self.config(), "credential_keys": sorted(deployment.CREDENTIAL_KEYS),
                    "native_job": deployment.desired_job()}
        self.assertEqual(dep.review_descriptor(self.bundle, self.launcher(), self.config()), expected)
        self.assertEqual(dep.review_hash(self.bundle, self.launcher(), self.config()), deployment.sha(deployment.encoded(expected)))

    def test_config_must_select_exactly_the_deployment_instance(self):
        for instance_id, config_id in (("team-a", "team-b"), ("team-a", None), (None, "team-a")):
            dep = self.dep(instance_id)
            self.assert_code("instance_config_mismatch", lambda: dep.review_descriptor(self.bundle, self.launcher(instance_id), self.config(config_id)))
        self.assertFalse((self.home / ".hstack").exists())

    def test_three_packs_and_legacy_coexist_and_rollback_is_local(self):
        deployments = [self.dep(), self.dep("daily"), self.dep("reviews"), self.dep("releases")]
        workflows = ["activity-brief", "activity-brief", "review-queue", "release-watch"]
        results = [self.install(dep, workflow) for dep, workflow in zip(deployments, workflows)]
        self.assertEqual(len(set(result["job_id"] for result in results)), 4)
        self.assertEqual({job["script"] for job in self.jobs()}, {dep.scope.script for dep in deployments})
        self.assertEqual(stat.S_IMODE((self.home / ".hstack/workflows").stat().st_mode), 0o700)
        for dep in deployments:
            dep.verify_installation(verify_job=True)
            (dep.root / "state/ack.json").write_text('{"message_id":42}')
        untouched = {path: path.read_bytes() for dep in deployments if dep.instance_id != "reviews" for path in dep._paths().values()}
        self.assertEqual(deployments[2].rollback()["status"], "rolled_back")
        self.assertEqual({path: path.read_bytes() for path in untouched}, untouched)
        self.assertEqual(len(self.jobs()), 3)
        self.assertEqual((deployments[2].root / "state/ack.json").read_text(), '{"message_id":42}')
        for dep in deployments[:2] + deployments[3:]:
            dep.verify_installation(verify_job=True)

    def test_two_instances_of_same_pack_are_distinct_and_duplicate_id_is_idempotent(self):
        first, second = self.dep("team-a"), self.dep("team-b")
        a, b = self.install(first), self.install(second)
        self.assertNotEqual(a["job_id"], b["job_id"])
        self.assertNotEqual(a["review_hash"], b["review_hash"])
        self.assertEqual(self.install(self.dep("team-a"))["status"], "unchanged")
        changed = self.config("team-a"); changed["repositories"] = ["example/other"]
        self.assert_code("existing_plan_requires_review", lambda: first.install(self.bundle, self.launcher("team-a"), changed, self.credentials))
        self.assertEqual(len(self.jobs()), 2)

    def test_parallel_instances_do_not_share_deployment_locks_or_lose_jobs(self):
        deployments = [self.dep("parallel-" + str(index)) for index in range(5)]
        with ThreadPoolExecutor(max_workers=5) as executor:
            results = list(executor.map(self.install, deployments))
        self.assertEqual(len(set(result["job_id"] for result in results)), 5)
        self.assertEqual(len(self.jobs()), 5)
        for dep in deployments:
            dep.verify_installation(verify_job=True)
        with deployments[0].runtime_guard():
            self.assert_code("deployment_busy", self.dep("parallel-0").rollback)
            self.assertEqual(deployments[1].rollback()["status"], "rolled_back")
        self.assertEqual(len(self.jobs()), 4)

    def test_one_instance_failure_cleans_only_that_instance(self):
        healthy, failed = self.dep("healthy"), self.dep("failed")
        good = self.install(healthy)
        os.environ["BRIEF_FAIL_INSTANCE"] = failed.scope.marker
        self.assert_code("install_failed_cleaned", lambda: self.install(failed))
        self.assertEqual(healthy.verify_installation(verify_job=True)["job_id"], good["job_id"])
        self.assertEqual(failed._read_receipt()["phase"], "rolled_back")
        self.assertEqual([job["id"] for job in self.jobs()], [good["job_id"]])

    def test_interrupted_install_can_resume_after_another_instance_is_installed(self):
        interrupted, other = self.dep("interrupted"), self.dep("other")
        original = interrupted._run
        def lose_control(args, **kwargs):
            result = original(args, **kwargs)
            if "create" in args:
                raise KeyboardInterrupt()
            return result
        with patch.object(interrupted, "_run", side_effect=lose_control):
            with self.assertRaises(KeyboardInterrupt):
                self.install(interrupted)
        self.assertEqual(interrupted._read_receipt()["phase"], "create_intended")
        self.install(other)
        self.assertEqual(self.install(interrupted)["status"], "installed")
        self.assertEqual(len(self.jobs()), 2)
        interrupted.verify_installation(verify_job=True)
        other.verify_installation(verify_job=True)

    def test_payload_drift_in_one_instance_does_not_disable_another(self):
        changed, healthy = self.dep("changed"), self.dep("healthy")
        self.install(changed); self.install(healthy)
        payload = changed.root / "credentials.json"
        payload.write_bytes(b"operator replacement")
        self.assert_code("owned_file_drift", lambda: changed.verify_installation(verify_job=True))
        healthy.verify_installation(verify_job=True)
        self.assertEqual(healthy.rollback()["status"], "rolled_back")
        self.assertEqual(payload.read_bytes(), b"operator replacement")
        self.assertEqual([job["script"] for job in self.jobs()], [changed.scope.script])

    def test_copied_receipt_is_rejected_before_job_or_payload_changes(self):
        first, second = self.dep("first"), self.dep("second")
        self.install(first); self.install(second)
        original = second.receipt.read_bytes()
        second.receipt.write_bytes(first.receipt.read_bytes())
        self.assert_code("receipt_drift", second.rollback)
        self.assertEqual(len(self.jobs()), 2)
        self.assertTrue(second.launcher.exists())
        second.receipt.write_bytes(original)
        second.verify_installation(verify_job=True)

    def test_wrong_config_binding_refuses_even_with_recomputed_file_checksum(self):
        first, second = self.dep("first"), self.dep("second")
        self.install(first); self.install(second)
        receipt = second._read_receipt()
        config = first.root / "config.json"
        (second.root / "config.json").write_bytes(config.read_bytes())
        receipt["files"]["config"]["sha256"] = deployment.sha(config.read_bytes())
        second._write_receipt(receipt)
        self.assert_code("instance_config_mismatch", lambda: second.verify_installation(verify_job=True))
        first.verify_installation(verify_job=True)

    def test_job_id_marker_or_script_cross_wiring_refuses_without_deleting_jobs(self):
        first, second = self.dep("first"), self.dep("second")
        self.install(first); self.install(second)
        original = self.jobs()
        for field, value in (("script", first.scope.script), ("prompt", deployment.desired_job("first")["prompt"])):
            jobs = copy.deepcopy(original)
            target = next(job for job in jobs if job["script"] == second.scope.script)
            target[field] = value
            self.save_jobs(jobs)
            self.assert_code("native_job_drift", lambda: second.verify_installation(verify_job=True))
        self.save_jobs(original)
        receipt = second._read_receipt(); receipt["job_id"] = first._read_receipt()["job_id"]
        second._write_receipt(receipt)
        self.assert_code("native_job_drift", second.rollback)
        first.verify_installation(verify_job=True)
        self.assertEqual(len(self.jobs()), 2)

    def test_existing_script_collision_without_marker_is_refused(self):
        dep = self.dep("collision")
        dep.scripts.mkdir()
        dep.launcher.write_bytes(b"operator script")
        self.assert_code("existing_workflow_requires_review", lambda: self.install(dep))
        self.assertEqual(dep.launcher.read_bytes(), b"operator script")
        dep.launcher.unlink()
        (self.home / "cron").mkdir()
        job = dict(deployment.desired_job("other"), id="foreign", script=dep.scope.script)
        self.save_jobs([job])
        self.assert_code("existing_workflow_requires_review", lambda: self.install(dep))
        self.assertEqual(self.jobs(), [job])

    def test_symlink_or_public_container_refuses_without_following_it(self):
        dep = self.dep("safe")
        dep.parent.mkdir(mode=0o700)
        elsewhere = Path(self.temp.name) / "operator-directory"
        elsewhere.mkdir(mode=0o700)
        container = dep.parent / "workflows"
        container.symlink_to(elsewhere, target_is_directory=True)
        self.assert_code("unsafe_path", lambda: self.install(dep))
        self.assertEqual(list(elsewhere.iterdir()), [])
        container.unlink(); container.mkdir(mode=0o755)
        self.assert_code("owned_directory_drift", lambda: self.install(dep))
        container.chmod(0o700)
        dep.root.symlink_to(elsewhere, target_is_directory=True)
        self.assert_code("unsafe_path", lambda: self.install(dep))
        self.assertEqual(list(elsewhere.iterdir()), [])

    def test_writable_shared_parent_cannot_redirect_private_instance_containers(self):
        dep = self.dep("safe")
        dep.parent.mkdir(mode=0o777)
        dep.parent.chmod(0o777)
        self.assert_code("owned_directory_drift", lambda: self.install(dep))
        legacy = self.dep()
        self.assert_code("owned_directory_drift", lambda: self.install(legacy))
        self.assertFalse((dep.parent / "workflows").exists())
        self.assertFalse(legacy.root.exists())
        self.assertEqual(self.jobs(), [])

    def test_scripts_directory_must_be_owned_and_not_writable_by_another_user(self):
        dep = self.dep("safe")
        dep.scripts.mkdir(mode=0o755)
        dep.scripts.chmod(0o777)
        self.assert_code("owned_directory_drift", lambda: self.install(dep))
        self.assert_code("owned_directory_drift", lambda: self.install(self.dep()))
        self.assertFalse(dep.root.exists())
        self.assertEqual(self.jobs(), [])
        dep.scripts.chmod(0o755)
        original = Path.lstat
        def foreign_owner(path, *args, **kwargs):
            info = original(path, *args, **kwargs)
            return SimpleNamespace(st_mode=info.st_mode, st_uid=info.st_uid + 1) if path == dep.scripts else info
        with patch.object(Path, "lstat", foreign_owner):
            self.assert_code("owned_directory_drift", lambda: self.install(dep))
        self.assertEqual(self.install(dep)["status"], "installed", "the ordinary 0755 native scripts directory remains supported")
        dep.scripts.chmod(0o777)
        self.assert_code("owned_directory_drift", lambda: dep.verify_installation(verify_job=True))
        self.assert_code("owned_directory_drift", dep.rollback)
        self.assertTrue(dep.launcher.exists(), "unsafe rollback must not remove the installed launcher")
        self.assertEqual(len(self.jobs()), 1)

    def test_target_home_must_be_owned_and_not_writable_by_another_user(self):
        dep = self.dep("safe")
        legacy = self.dep()
        self.home.chmod(0o777)
        self.assert_code("unsafe_target", lambda: self.dep("safe"))
        self.assert_code("unsafe_target", self.dep)
        with patch.object(dep, "_run") as cli:
            self.assert_code("unsafe_target", lambda: self.install(dep))
            cli.assert_not_called()
        with patch.object(legacy, "_run") as cli:
            self.assert_code("unsafe_target", lambda: self.install(legacy))
            cli.assert_not_called()
        self.assertFalse(dep.parent.exists(), "refusal happens before even creating a deployment lock")
        self.assertEqual(self.jobs(), [])
        self.home.chmod(0o755)
        original = Path.lstat
        def foreign_owner(path, *args, **kwargs):
            info = original(path, *args, **kwargs)
            return SimpleNamespace(st_mode=info.st_mode, st_uid=info.st_uid + 1) if path == self.home else info
        with patch.object(Path, "lstat", foreign_owner), patch.object(dep, "_run") as cli:
            self.assert_code("unsafe_target", lambda: self.install(dep))
            cli.assert_not_called()
        self.assertEqual(self.install(dep)["status"], "installed", "owned 0755 homes remain supported")
        self.home.chmod(0o777)
        self.assert_code("unsafe_target", lambda: dep.verify_installation(verify_job=True))
        self.assert_code("unsafe_target", dep.rollback)
        self.assertTrue(dep.launcher.exists())
        self.assertEqual(len(self.jobs()), 1)


if __name__ == "__main__":
    unittest.main()
