"""Pack routing and private credential capture, with no live services."""
from datetime import datetime, timezone
from contextlib import redirect_stdout, redirect_stderr
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import warnings

SOURCE = Path(__file__).resolve().parents[3] / "packages/founder-brief"
sys.path.insert(0, str(SOURCE))
import workflow
import build

CONFIG = {"schema_version": 1, "repositories": ["acme/widget"], "telegram_chat_id": "555000111",
          "daily_time": "09:00", "timezone": "UTC", "window_hours": 24}
TOKEN = "123456:FAKE" + "x" * 32


class EmptyGitHub:
    token = ""

    def __init__(self, incomplete=False):
        self.calls = []
        self.incomplete = incomplete

    def get(self, endpoint, params):
        self.calls.append((endpoint, params))
        return [], self.incomplete


class PackRuntimeTests(unittest.TestCase):
    def test_legacy_configuration_is_unchanged_and_pack_choices_are_closed(self):
        self.assertEqual(workflow.validate_config(CONFIG), CONFIG)
        for name in workflow.WORKFLOWS:
            self.assertEqual(workflow.validate_config({**CONFIG, "workflow": name})["workflow"], name)
        for value in (None, [], {}, "unknown", "$(execute)"):
            with self.subTest(value=value), self.assertRaises(workflow.WorkflowError):
                workflow.validate_config({**CONFIG, "workflow": value})

    def test_preview_routes_only_selected_sources_without_target_or_send(self):
        expected = {"activity-brief": ["commits", "issues", "pulls"],
                    "review-queue": ["pulls"], "release-watch": ["releases"]}
        for name, sources in expected.items():
            with self.subTest(workflow=name):
                client = EmptyGitHub()
                text = workflow.preview({**CONFIG, "workflow": name},
                                        now=datetime(2026, 10, 23, 8, tzinfo=timezone.utc), _client=client)
                self.assertIsInstance(text, str)
                self.assertEqual([call[0].rsplit("/", 1)[-1] for call in client.calls], sources)
                self.assertNotIn("INCOMPLETE", text)

    def test_incomplete_preview_returns_no_healthy_report(self):
        for name in workflow.WORKFLOWS:
            with self.subTest(workflow=name), self.assertRaisesRegex(workflow.WorkflowError, "github_collection_incomplete") as failed:
                workflow.preview({**CONFIG, "workflow": name}, _client=EmptyGitHub(incomplete=True))
            self.assertTrue(failed.exception.details["sources"])
            self.assertTrue(all(row["reason"] == "truncated" for row in failed.exception.details["sources"]))
            self.assertIn("volume limits", failed.exception.details["hint"])

    def test_preview_cli_reports_api_quota_without_a_brief_or_native_actions(self):
        collector = workflow.collector_module()
        class RateLimited:
            token = ""
            def get(self, endpoint, params):
                raise collector.BriefError("rate_limited")
        with tempfile.TemporaryDirectory(prefix="hstack-preview-error-") as directory:
            config = Path(directory) / "config.json"
            config.write_text(workflow.canonical({**CONFIG, "workflow": "review-queue"}))
            config.chmod(0o600)
            output, diagnostic = io.StringIO(), io.StringIO()
            with patch.object(workflow, "collector_module", return_value=collector), \
                    patch.object(collector, "GitHubClient", return_value=RateLimited()), \
                    redirect_stdout(output), redirect_stderr(diagnostic):
                status = workflow.main(["preview", "--config", str(config)])
            self.assertEqual(status, 1)
            self.assertEqual(output.getvalue(), "")
            error = json.loads(diagnostic.getvalue())
            self.assertEqual(error["details"]["sources"], [{"repository_index": 1, "source": "pulls",
                                                          "status": "error", "reason": "rate_limited"}])
            self.assertIn("read token", error["details"]["hint"])
            self.assertNotIn(directory, diagnostic.getvalue())
            self.assertEqual(list(Path(directory).iterdir()), [config])

    def test_credentials_are_hidden_private_validated_and_never_overwritten(self):
        with tempfile.TemporaryDirectory(prefix="hstack-credentials-test-") as directory:
            parent = Path(directory)
            file = parent / "credentials.json"
            values = iter((TOKEN, ""))
            result = workflow.save_credentials(file, _prompt=lambda _: next(values))
            self.assertEqual(set(result), {"status", "file"})
            self.assertNotIn(TOKEN, json.dumps(result))
            self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o600)
            self.assertEqual(workflow.private_json(file), {"GITHUB_TOKEN": "", "TELEGRAM_BOT_TOKEN": TOKEN})
            with self.assertRaisesRegex(workflow.WorkflowError, "refusing_existing_credentials"):
                workflow.save_credentials(file, _prompt=lambda _: self.fail("must not prompt before refusal"))
            self.assertEqual(workflow.private_json(file)["TELEGRAM_BOT_TOKEN"], TOKEN)

    def test_invalid_credentials_and_unsafe_destinations_leave_no_file(self):
        with tempfile.TemporaryDirectory(prefix="hstack-credentials-test-") as directory:
            parent = Path(directory)
            target = parent / "credentials.json"
            values = iter(("bad-token", ""))
            with self.assertRaises(workflow.WorkflowError):
                workflow.save_credentials(target, _prompt=lambda _: next(values))
            self.assertFalse(target.exists())
            self.assertEqual(list(parent.iterdir()), [])
            def cannot_hide(_):
                warnings.warn("cannot hide", workflow.getpass.GetPassWarning)
                self.fail("echo fallback must never read input")
            with self.assertRaisesRegex(workflow.WorkflowError, "credentials_require_hidden_terminal"):
                workflow.save_credentials(target, _prompt=cannot_hide)
            self.assertFalse(target.exists())
            target.symlink_to(parent / "absent.json")
            with self.assertRaises(workflow.WorkflowError):
                workflow.save_credentials(target, _prompt=lambda _: self.fail("no prompt"))
            self.assertFalse((parent / "absent.json").exists())
            target.unlink()
            parent.chmod(0o755)
            with self.assertRaisesRegex(workflow.WorkflowError, "private_directory"):
                workflow.save_credentials(target, _prompt=lambda _: self.fail("no prompt"))

    def test_packaged_discovery_needs_no_home_and_non_tty_never_echoes_tokens(self):
        with tempfile.TemporaryDirectory(prefix="hstack-pack-cli-") as directory:
            runtime = Path(directory) / "runtime.pyz"
            runtime.write_bytes(build.build())
            runtime.chmod(0o700)
            args = [sys.executable, "-I", "-B", str(runtime)]
            found = subprocess.run(args + ["packs"], capture_output=True, text=True, check=False)
            self.assertEqual(found.returncode, 0, found.stderr)
            self.assertEqual({item["id"] for item in json.loads(found.stdout)["workflows"]}, set(workflow.WORKFLOWS))
            target = Path(directory) / "credentials.json"
            captured = subprocess.run(args + ["credentials", "--output", str(target)],
                                      input=TOKEN, capture_output=True, text=True, check=False)
            self.assertEqual(captured.returncode, 1)
            self.assertEqual(captured.stdout, "")
            self.assertNotIn(TOKEN, captured.stderr)
            self.assertIn("credentials_require_interactive_terminal", captured.stderr)
            self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
