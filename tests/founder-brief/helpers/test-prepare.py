"""Offline preparation UX: actual checkout and packaged CLI, no service calls."""
from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / "packages" / "founder-brief"


def load(name):
    spec = importlib.util.spec_from_file_location("prepare_test_" + name, SOURCE / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


prepare = load("prepare")
build = load("build")
workflow = load("workflow")


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hstack-pack-prepare-")
        self.root = Path(self.temp.name).resolve()
        self.output = self.root / "prepared"
        self.runtime = build.build()

    def tearDown(self):
        self.temp.cleanup()

    def argv(self, workflow_name="activity-brief", output=None):
        return ["--workflow", workflow_name, "--repository", "Zed/Project", "--repository", "Acme/App",
                "--chat-id", "555000111", "--output", str(output or self.output)]

    def call(self, argv=None, runtime=None):
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = prepare.main(argv or self.argv(), runtime_bytes=self.runtime if runtime is None else runtime)
        return code, stdout.getvalue(), stderr.getvalue()

    def test_all_packs_prepare_valid_explicit_defaults_and_exact_runtime_without_json_authoring(self):
        for name in prepare.WORKFLOWS:
            with self.subTest(workflow=name):
                output = self.root / name
                code, stdout, stderr = self.call(self.argv(name, output))
                self.assertEqual((code, stderr), (0, ""))
                result = json.loads(stdout)
                self.assertEqual(result["workflow"], name)
                self.assertEqual(result["instance_id"], name)
                config = json.loads((output / "config.json").read_text())
                self.assertEqual(config, result["configuration"])
                self.assertEqual(config["repositories"], ["acme/app", "zed/project"])
                self.assertEqual((config["workflow"], config["daily_time"], config["timezone"], config["window_hours"]),
                                 (name, "09:00", "UTC", 24))
                self.assertEqual(workflow.validate_config(config), config)
                self.assertEqual(config["instance_id"], name)
                self.assertEqual((output / "runtime.pyz").read_bytes(), self.runtime)
                self.assertEqual(result["evidence_scope"], "offline_preparation_only")
                self.assertTrue(result["target_transfer_required"])

    def test_files_are_private_even_with_a_restrictive_umask_and_example_is_not_installable(self):
        prior = os.umask(0o777)
        try:
            code, stdout, stderr = self.call()
        finally:
            os.umask(prior)
        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(stat.S_IMODE(self.output.stat().st_mode), 0o700)
        modes = {file.name: stat.S_IMODE(file.stat().st_mode) for file in self.output.iterdir()}
        self.assertEqual(modes, {"runtime.pyz": 0o700, "config.json": 0o600,
                                 "credentials.example.json": 0o600, "NEXT_STEPS.md": 0o600})
        example = json.loads((self.output / "credentials.example.json").read_text())
        with self.assertRaises(workflow.WorkflowError):
            workflow.validate_credentials(example)
        self.assertIn("invalid placeholder", (self.output / "NEXT_STEPS.md").read_text())
        self.assertNotIn("credentials.json", {file.name for file in self.output.iterdir()})

    def test_invalid_configuration_and_runtime_have_no_filesystem_side_effects(self):
        for flag, value in (("--repository", "../bad"), ("--repository", "acme/app"),
                            ("--chat-id", "-100123"), ("--chat-id", "00123"),
                            ("--at", "25:00"), ("--timezone", "Bad/Zone"),
                            ("--instance", "../escape"), ("--instance", "UPPERCASE"),
                            ("--instance", ""), ("--instance", "-leading"),
                            ("--window-hours", "0"), ("--window-hours", "169")):
            with self.subTest(flag=flag, value=value):
                code, stdout, stderr = self.call(self.argv() + [flag + "=" + value])
                self.assertEqual(code, 1)
                self.assertEqual(stdout, "")
                self.assertEqual(json.loads(stderr)["status"], "unprepared")
                self.assertFalse(self.output.exists())
        for runtime in (b"", b"x" * (prepare.MAX_RUNTIME + 1), "text"):
            code, stdout, stderr = self.call(runtime=runtime)
            self.assertEqual(code, 1)
            self.assertEqual(json.loads(stderr)["error"], "invalid_runtime")
            self.assertFalse(self.output.exists())

    def test_unknown_workflow_is_rejected_by_argument_parser_before_any_write(self):
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
            prepare.main(self.argv("unknown"), runtime_bytes=self.runtime)
        self.assertEqual(error.exception.code, 2)
        self.assertFalse(self.output.exists())

    def test_existing_file_directory_and_symlink_are_never_clobbered(self):
        file = self.root / "prior-file"
        file.write_bytes(b"operator file")
        directory = self.root / "prior-directory"
        directory.mkdir()
        (directory / "operator").write_bytes(b"operator directory")
        symlink = self.root / "prior-link"
        symlink.symlink_to(directory, target_is_directory=True)
        for output in (file, directory, symlink):
            code, stdout, stderr = self.call(self.argv(output=output))
            self.assertEqual(code, 1)
            self.assertEqual(json.loads(stderr)["error"], "output_already_exists")
        self.assertEqual(file.read_bytes(), b"operator file")
        self.assertEqual((directory / "operator").read_bytes(), b"operator directory")
        self.assertTrue(symlink.is_symlink())

    def test_symlink_and_world_writable_nonsticky_parents_are_refused(self):
        parent = self.root / "parent"
        parent.mkdir()
        link = self.root / "parent-link"
        link.symlink_to(parent, target_is_directory=True)
        code, _, stderr = self.call(self.argv(output=link / "prepared"))
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(stderr)["error"], "unsafe_output_parent")
        self.assertEqual(list(parent.iterdir()), [])
        parent.chmod(0o777)
        code, _, stderr = self.call(self.argv(output=parent / "prepared"))
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(stderr)["error"], "unsafe_output_parent")
        self.assertEqual(list(parent.iterdir()), [])

    def test_shared_validation_comes_from_checkout_not_ambient_same_named_module(self):
        ambient = mock.Mock()
        ambient.validate_config.side_effect = AssertionError("ambient code must not run")
        with mock.patch.dict(sys.modules, {"workflow": ambient}):
            code, stdout, stderr = self.call()
        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(json.loads(stdout)["configuration"]["workflow"], "activity-brief")
        ambient.validate_config.assert_not_called()

    def test_failed_write_cleans_only_freshly_created_entries(self):
        with mock.patch.object(prepare.os, "fsync", side_effect=OSError("private failure detail")):
            code, stdout, stderr = self.call()
        self.assertEqual(code, 1)
        self.assertEqual(stdout, "")
        self.assertNotIn("private failure detail", stderr)
        self.assertFalse(self.output.exists())
        self.assertEqual(list(self.root.iterdir()), [])

    def test_failure_preserves_an_unrelated_file_created_during_preparation(self):
        def interrupt(_fd):
            (self.output / "operator-file").write_bytes(b"keep operator bytes")
            raise OSError("interrupted")
        with mock.patch.object(prepare.os, "fsync", side_effect=interrupt):
            code, _, _ = self.call()
        self.assertEqual(code, 1)
        self.assertEqual([file.name for file in self.output.iterdir()], ["operator-file"])
        self.assertEqual((self.output / "operator-file").read_bytes(), b"keep operator bytes")

    def test_command_arrays_have_quoted_equivalents_and_paths_are_inert(self):
        marker = self.root / "marker"
        output = self.root / "space ' $(touch marker); target"
        code, stdout, stderr = self.call(self.argv(output=output))
        self.assertEqual((code, stderr), (0, ""))
        result = json.loads(stdout)
        self.assertEqual(Path(result["files"]["config"]), output / "config.json")
        self.assertFalse(marker.exists())
        self.assertEqual(set(result["next_commands"]), {"canary", "credentials", "install", "preview", "review", "status", "rollback", "list"})
        for command in result["next_commands"].values():
            self.assertEqual(shlex.split(command["shell"]), command["argv"])
            self.assertIn("<TARGET_PREPARED_DIRECTORY>/runtime.pyz", command["argv"])
        credentials = result["next_commands"]["credentials"]["argv"]
        self.assertEqual(credentials[-3:], ["credentials", "--output", "<TARGET_CREDENTIALS_JSON>"])
        for name in ("canary", "status", "rollback"):
            argv = result["next_commands"][name]["argv"]
            self.assertEqual(argv[argv.index("--instance") + 1], "activity-brief")

    def test_custom_instance_is_bound_to_configuration_and_operation_commands(self):
        code, stdout, stderr = self.call(self.argv("review-queue") + ["--instance", "team-a-reviews"])
        self.assertEqual((code, stderr), (0, ""))
        result = json.loads(stdout)
        self.assertEqual(result["configuration"]["instance_id"], "team-a-reviews")
        for name in ("canary", "status", "rollback"):
            argv = result["next_commands"][name]["argv"]
            self.assertEqual(argv[argv.index("--instance") + 1], "team-a-reviews")

    def test_actual_checkout_cli_is_deterministic_and_ignores_ambient_credentials(self):
        secret = "never_copy_this_private_test_secret"
        environment = {**os.environ, "GITHUB_TOKEN": secret, "TELEGRAM_BOT_TOKEN": secret}
        command = [sys.executable, "-I", "-B", str(SOURCE / "prepare.py")]
        outputs = []
        for index in range(2):
            destination = self.root / ("checkout-" + str(index))
            result = subprocess.run(command + self.argv(output=destination), cwd=self.root, env=environment,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertNotIn(secret.encode(), result.stdout + result.stderr)
            for file in destination.iterdir():
                self.assertNotIn(secret.encode(), file.read_bytes())
            outputs.append(destination)
        for name in ("runtime.pyz", "config.json", "credentials.example.json", "NEXT_STEPS.md"):
            self.assertEqual((outputs[0] / name).read_bytes(), (outputs[1] / name).read_bytes())

    def test_actual_packaged_prepare_reuses_its_exact_reviewed_archive(self):
        runtime = self.root / "source.pyz"
        runtime.write_bytes(self.runtime)
        result = subprocess.run([sys.executable, "-I", "-B", str(runtime), "prepare"] + self.argv("release-watch"),
                                cwd=self.root, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual((self.output / "runtime.pyz").read_bytes(), self.runtime)
        self.assertEqual(json.loads(result.stdout)["workflow"], "release-watch")


if __name__ == "__main__":
    unittest.main()
