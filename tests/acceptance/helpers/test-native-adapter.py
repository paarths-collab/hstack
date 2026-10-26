"""Offline model checks for the narrowly scoped release adapter, not a Hermes runtime test."""
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

source = Path(__file__).resolve().parents[3] / "packages/acceptance/target/native-hermes-v0_22_5.py"
spec = importlib.util.spec_from_file_location("hstack_native", source)
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class StoreAdapter(native.Adapter):
    """Represent CLI's side effects explicitly; never execute Hermes or a live service."""
    def __init__(self, home):
        super().__init__(str(home), "/example/hermes")
        self.calls = []
        self.sequence = 100
        self.lose_create = False

    def create(self, config):
        native.restorable(config)
        self.calls.append(("create", copy.deepcopy(config)))
        rows = json.loads((self.home / "cron/jobs.json").read_text())["jobs"]
        self.sequence += 1
        job = raw_job("job{}".format(self.sequence), config)
        rows.append(job)
        self.save(rows)
        if self.lose_create:
            self.lose_create = False
            native.refuse("native_cron_cli_failed", "native_cli_outcome_unconfirmed", 1)

    def run(self, args):
        self.calls.append(tuple(args))
        if args[0] != "remove":
            raise AssertionError("unexpected mutation")
        rows = json.loads((self.home / "cron/jobs.json").read_text())["jobs"]
        self.save([row for row in rows if row["id"] != args[1]])

    def save(self, rows):
        (self.home / "cron").mkdir(exist_ok=True)
        (self.home / "cron/jobs.json").write_text(json.dumps({"jobs": rows, "updated_at": "example"}))


def raw_job(identifier, config):
    # Fields and shapes from v0.22.5 cron.jobs.create_job. The fixture is explicitly
    # a data model, not a claim that the upstream implementation executed here.
    job = copy.deepcopy(config)
    job.update(id=identifier, skill=config["skills"][0] if config["skills"] else None,
               schedule_display=config["schedule"].get("expr"),
               state="scheduled" if config["enabled"] else "paused", created_at="example",
               next_run_at="later", last_run_at=None, last_status=None, last_error=None,
               last_delivery_error=None, last_delivery_unverified=None, last_failure=None,
               failure_streak=0, monitor_state=None, paused_at=None)
    job["repeat"]["completed"] = 0
    job["schedule"]["display"] = config["schedule"].get("expr")
    return job


class NativeAdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hstack-native-test-")
        self.home = Path(self.temp.name).resolve() / ".hermes"
        self.home.mkdir()
        self.txn = self.home / ".hstack/txn/native000001"
        self.txn.mkdir(parents=True)
        self.adapter = StoreAdapter(self.home)
        self.adapter.save([])
        self.schedule = "0 8 * * 1-5"
        self.prompt = "[hstack:founder-brief] Summarize activity safely."
        self.config = native.desired("founder-brief", self.schedule, self.prompt)

    def tearDown(self):
        self.temp.cleanup()

    def dispatch(self, operation, *args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.adapter.dispatch(operation, list(args))
        return dict(line.split("=", 1) for line in out.getvalue().splitlines())

    def backup(self):
        return self.dispatch("backup", str(self.txn))

    def intent(self):
        self.dispatch("intend", str(self.txn), "founder-brief", self.schedule, self.prompt)

    def ensure(self):
        return self.dispatch("ensure", str(self.txn), "founder-brief", self.schedule, self.prompt)

    def test_readonly_missing_store_creates_nothing(self):
        (self.home / "cron/jobs.json").unlink()
        (self.home / "cron").rmdir()
        before = list(self.home.rglob("*"))
        self.assertEqual(self.dispatch("inspect")["cron_managed_ids"], "")
        self.assertEqual(list(self.home.rglob("*")), before)

    def test_multiline_foreign_prompts_stay_data_and_out_of_output(self):
        foreign = copy.deepcopy(self.config)
        foreign["prompt"] = "untrusted\nline\twith=private-data"
        self.adapter.save([raw_job("foreign", foreign)])
        result = self.dispatch("inspect")
        self.assertEqual(result["cron_other_count"], "1")
        self.assertNotIn("private-data", repr(result))
        self.assertEqual(len(result["cron_other_sig"]), 64)

    def test_duplicate_json_keys_and_ids_are_refused(self):
        (self.home / "cron/jobs.json").write_text('{"jobs":[],"jobs":[]}')
        with self.assertRaises(native.Refusal):
            self.dispatch("inspect")
        row = raw_job("duplicate", self.config)
        self.adapter.save([row, row])
        with self.assertRaises(native.Refusal):
            self.dispatch("inspect")

    def test_symlink_store_and_directory_are_refused(self):
        file = self.home / "cron/jobs.json"
        outside = self.home / "outside"
        outside.write_text('{"jobs":[]}')
        file.unlink()
        file.symlink_to(outside)
        with self.assertRaises(native.Refusal):
            self.dispatch("inspect")
        file.unlink()
        file.parent.rmdir()
        file.parent.symlink_to(self.home)
        with self.assertRaises(native.Refusal):
            self.dispatch("inspect")

    def test_fifo_store_and_registry_are_refused_without_waiting_for_a_writer(self):
        if not hasattr(os, "mkfifo"):
            self.skipTest("FIFO test requires a POSIX target")
        for relative, operation in (("cron/jobs.json", "inspect"), ("gateway_state.json", "service-check")):
            file = self.home / relative
            if file.exists():
                file.unlink()
            os.mkfifo(str(file))
            result = subprocess.run([sys.executable, "-I", "-B", str(source), str(self.home), "/example/hermes", operation],
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, check=False)
            self.assertEqual(result.returncode, 4)
            self.assertIn(b"detail=invalid_file_type_or_size", result.stdout)
            self.assertTrue(file.is_fifo())
            file.unlink()

    def test_unsupported_store_shapes_do_not_auto_repair(self):
        file = self.home / "cron/jobs.json"
        for payload in ([], {"jobs": {}}, {"jobs": [None]}, {"jobs": [], "schema": 2}):
            file.write_text(json.dumps(payload))
            before = file.read_bytes()
            with self.assertRaises(native.Refusal):
                self.dispatch("inspect")
            self.assertEqual(file.read_bytes(), before)

    def test_progress_is_ignored_but_operator_configuration_is_not(self):
        foreign = copy.deepcopy(self.config)
        foreign["prompt"] = "foreign"
        row = raw_job("other", foreign)
        self.adapter.save([row])
        before = self.dispatch("inspect")["cron_other_sig"]
        row.update(last_run_at="later", last_status="ok", failure_streak=3)
        row["repeat"]["completed"] = 4
        self.adapter.save([row])
        self.assertEqual(self.dispatch("inspect")["cron_other_sig"], before)
        row["model"] = "changed"
        self.adapter.save([row])
        self.assertNotEqual(self.dispatch("inspect")["cron_other_sig"], before)

    def test_native_run_bookkeeping_does_not_break_verification_or_recovery(self):
        # Exact persisted field names from v0.22.5 cron/jobs.py trigger_job,
        # _get_due_job and mark_job_run, plus unreachable_retry.py/quota_hold.py.
        # Before this regression, a real successful run's canonical_completions
        # changed the configuration signature and made verify/restore refuse.
        self.backup()
        self.intent()
        self.ensure()
        rows = json.loads((self.home / "cron/jobs.json").read_text())["jobs"]
        rows[0].update(
            canonical_completions=["execution-123"], manual_run_at="2026-10-23T09:00:00Z",
            manual_run_prompt=None, pending_slot={"scheduled_at": "2026-10-23T09:00:00Z"},
            preflight_alerted=True, unreachable_retry={"attempt": 1, "at": "later", "expr": self.schedule},
            quota_hold_cron_expr=self.schedule, quota_hold_until="later",
            last_status="ok", last_run_at="2026-10-23T09:00:00Z")
        self.adapter.save(rows)
        verified = self.dispatch("verify", str(self.txn), "founder-brief", self.schedule)
        self.assertEqual(verified["cron_check"], "pass")
        self.assertEqual(self.ensure()["cron_result"], "unchanged")
        self.dispatch("restore-check", str(self.txn))
        self.dispatch("restore", str(self.txn))
        self.assertEqual(self.adapter.jobs(), [])

    def test_numeric_cron_bounds_are_checked_before_backup_or_intent(self):
        for schedule in ("0 0 1 1 0", "59 23 31 12 7", "*/15 8-18/2 1,15 1-12 1-5", "5/10 * * * *"):
            self.assertEqual(native.valid_schedule(schedule), schedule)
        invalid = ("99 8 * * *", "0 24 * * *", "0 8 0 * *", "0 8 * 13 *", "0 8 * * 8",
                   "*/0 8 * * *", "20-10 8 * * *", "1,,2 8 * * *", "1/ 8 * * *", ",1 8 * * *",
                   "0 8 * * -1", "0 8 * * 1-8", "0 8 * * 1/0", "0 8 * * */0")
        for schedule in invalid:
            with self.assertRaises(native.Refusal, msg=schedule):
                native.valid_schedule(schedule)
            row = raw_job("owned", self.config)
            row["schedule"]["expr"] = schedule
            self.adapter.save([row])
            with self.assertRaises(native.Refusal, msg=schedule):
                self.backup()
            self.assertFalse((self.txn / native.BEFORE).exists())
        self.adapter.save([])
        self.backup()
        for schedule in invalid:
            with self.assertRaises(native.Refusal, msg=schedule):
                self.dispatch("intend", str(self.txn), "founder-brief", schedule, self.prompt)
        self.assertFalse((self.txn / native.PLAN).exists())
        self.assertEqual(self.adapter.calls, [])

    def test_unsupported_owned_config_refuses_before_backup(self):
        for key, value in (("enabled_toolsets", []), ("base_url", "https://example.invalid"), ("unknown_key", True)):
            row = raw_job("owned", self.config)
            row[key] = value
            self.adapter.save([row])
            with self.assertRaises(native.Refusal):
                self.backup()
            self.assertFalse((self.txn / native.BEFORE).exists())
        self.assertEqual(self.adapter.calls, [])

    def test_half_paused_managed_jobs_refuse_backup_and_live_preflight(self):
        row = raw_job("halfpaused", self.config)
        row["paused_at"] = "2026-10-23T00:00:00Z"
        self.adapter.save([row])
        unchanged = (self.home / "cron/jobs.json").read_bytes()
        with self.assertRaises(native.Refusal):
            self.backup()
        self.assertFalse((self.txn / native.BEFORE).exists())
        self.assertEqual((self.home / "cron/jobs.json").read_bytes(), unchanged)
        self.adapter.save([])
        self.backup()
        self.intent()
        self.ensure()
        rows = json.loads((self.home / "cron/jobs.json").read_text())["jobs"]
        rows[0]["paused_at"] = "2026-10-23T00:00:00Z"
        self.adapter.save(rows)
        before_calls = list(self.adapter.calls)
        unchanged = (self.home / "cron/jobs.json").read_bytes()
        for operation in ("preflight", "intend", "ensure"):
            with self.assertRaises(native.Refusal):
                self.dispatch(operation, str(self.txn), "founder-brief", self.schedule, self.prompt)
        self.assertEqual(self.adapter.calls, before_calls)
        self.assertEqual((self.home / "cron/jobs.json").read_bytes(), unchanged)

    def test_noncanonical_prior_values_are_refused_before_backup(self):
        for key, value in (("prompt", " " + self.prompt + " "), ("name", ""),
                           ("model", " model-a "), ("provider", " provider-a "),
                           ("reasoning_effort", "HIGH"), ("reasoning_effort", "disabled"),
                           ("failure_deliver", " local "), ("paused_reason", " Awaiting operator ")):
            row = raw_job("noncanonical", self.config)
            row[key] = value
            if key == "paused_reason":
                row.update(enabled=False, state="paused")
            self.adapter.save([row])
            with self.assertRaises(native.Refusal, msg=key):
                self.backup()
            self.assertFalse((self.txn / native.BEFORE).exists())
        self.assertEqual(self.adapter.calls, [])

    def test_noncanonical_new_prompt_is_refused_before_creating_an_intent(self):
        self.backup()
        for operation in ("preflight", "intend", "ensure"):
            with self.assertRaises(native.Refusal):
                self.dispatch(operation, str(self.txn), "founder-brief", self.schedule, " " + self.prompt + " ")
        self.assertFalse((self.txn / native.PLAN).exists())
        self.assertEqual(self.adapter.calls, [])

    def test_cli_fixture_applies_the_tagged_text_normalizers(self):
        fixture = Path(__file__).resolve().parents[1] / "target/helpers/native-hermes-v0_22_5"
        env = dict(os.environ, HOME=str(self.home.parent), HERMES_HOME=str(self.home), PYTHONDONTWRITEBYTECODE="1")
        result = subprocess.run([sys.executable, "-I", "-B", str(fixture), "--profile", "default", "cron", "create",
                                 " 0 9 * * * ", " [hstack:founder-brief] Brief ", "--name", "", "--deliver", "telegram",
                                 "--model", " model-a ", "--provider", " provider-a ", "--reasoning-effort", "HIGH",
                                 "--paused", "--paused-reason", " Awaiting operator "],
                                env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        row = json.loads((self.home / "cron/jobs.json").read_text())["jobs"][0]
        self.assertEqual(row["prompt"], "[hstack:founder-brief] Brief")
        self.assertEqual(row["name"], "[hstack:founder-brief] Brief")
        self.assertEqual(row["schedule"]["expr"], "0 9 * * *")
        self.assertEqual((row["model"], row["provider"], row["reasoning_effort"]), ("model-a", "provider-a", "high"))
        self.assertEqual(row["paused_reason"], "Awaiting operator")

    def test_option_looking_prior_values_roundtrip_through_the_public_parser_fixture(self):
        fixture = Path(__file__).resolve().parents[1] / "target/helpers/native-hermes-v0_22_5"
        env = dict(os.environ, HOME=str(self.home.parent), HERMES_HOME=str(self.home), PYTHONDONTWRITEBYTECODE="1")
        # Negative control: the old option/value pair is rejected before writing.
        before = (self.home / "cron/jobs.json").read_bytes()
        result = subprocess.run([sys.executable, "-I", "-B", str(fixture), "--profile", "default", "cron", "create",
                                 self.schedule, self.prompt, "--name", "--daily", "--deliver", "local"],
                                env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, check=False)
        self.assertEqual(result.returncode, 2)
        self.assertEqual((self.home / "cron/jobs.json").read_bytes(), before)

        class ParserFixtureAdapter(native.Adapter):
            def run(adapter, args):
                result = subprocess.run([sys.executable, "-I", "-B", str(fixture), "--profile", "default", "cron"] + args,
                                        env={**adapter.environment(), "HOME": str(self.home.parent)},
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, check=False)
                if result.returncode:
                    raise AssertionError(result.stderr)

        prior = copy.deepcopy(self.config)
        prior.update(name="--daily", prompt="--old [hstack:founder-brief] Brief", model="--model-a", provider="--provider-a",
                     enabled=False, paused_reason="--paused")
        self.adapter.save([raw_job("prior", prior)])
        self.adapter = ParserFixtureAdapter(str(self.home), "/example/hermes")
        self.backup()
        self.intent()
        self.ensure()
        self.dispatch("restore", str(self.txn))
        self.assertEqual(self.adapter.jobs()[0]["config"], prior)

    def test_backup_allows_only_exact_unpublished_transaction_name(self):
        staging = self.txn.parent / ".tmp.native000002.123"
        staging.mkdir()
        self.dispatch("backup", str(staging))
        self.assertEqual((staging / native.BEFORE).stat().st_mode & 0o777, 0o600)
        with self.assertRaises(native.Refusal):
            self.dispatch("restore-check", str(staging))
        other = self.txn.parent / ".tmp.bad"
        other.mkdir()
        with self.assertRaises(native.Refusal):
            self.dispatch("backup", str(other))

    def test_preintent_addition_and_deletion_conflicts_are_readonly(self):
        row = raw_job("prior", self.config)
        self.adapter.save([row])
        self.backup()
        self.adapter.save([])
        with self.assertRaises(native.Refusal) as caught:
            self.intent()
        self.assertEqual(caught.exception.status, 3)
        self.assertFalse((self.txn / native.PLAN).exists())
        self.assertEqual(self.adapter.calls, [])

    def test_ensure_requires_intent_and_never_rewrites_it(self):
        self.backup()
        with self.assertRaises(native.Refusal):
            self.ensure()
        self.intent()
        plan = (self.txn / native.PLAN).read_bytes()
        self.assertEqual(self.ensure()["cron_result"], "created")
        self.assertEqual(self.ensure()["cron_result"], "unchanged")
        self.assertEqual((self.txn / native.PLAN).read_bytes(), plan)
        self.assertEqual(self.dispatch("verify", str(self.txn), "founder-brief", self.schedule)["cron_check"], "pass")
        self.dispatch("restore", str(self.txn))
        self.assertEqual(self.adapter.jobs(), [])
        self.assertEqual((self.txn / native.PLAN).read_bytes(), plan)

    def test_lost_create_reply_can_be_reconciled_and_restored(self):
        self.backup()
        self.intent()
        self.adapter.lose_create = True
        with self.assertRaises(native.Refusal):
            self.ensure()
        self.assertEqual(len(self.adapter.jobs()), 1)
        self.dispatch("restore-check", str(self.txn))
        self.dispatch("restore", str(self.txn))
        self.dispatch("verify-restored", str(self.txn))
        self.assertEqual(self.adapter.jobs(), [])

    def test_restore_preserves_supported_prior_delivery_model_and_paused_state(self):
        prior = copy.deepcopy(self.config)
        prior.update(name="prior label", prompt="[hstack:founder-brief] Prior prompt", deliver="local", skills=[],
                     model="model-a", provider="provider-a", enabled=False, paused_reason="Awaiting operator")
        self.adapter.save([raw_job("prior", prior)])
        self.backup()
        self.intent()
        self.assertEqual(self.ensure()["cron_result"], "updated")
        self.dispatch("restore", str(self.txn))
        self.assertEqual(self.adapter.jobs()[0]["config"], prior)

    def test_user_edit_blocks_restore_without_any_mutation(self):
        self.backup()
        self.intent()
        self.ensure()
        rows = json.loads((self.home / "cron/jobs.json").read_text())["jobs"]
        rows[0]["deliver"] = "local"
        self.adapter.save(rows)
        before = len(self.adapter.calls)
        with self.assertRaises(native.Refusal):
            self.dispatch("restore", str(self.txn))
        self.assertEqual(len(self.adapter.calls), before)

    def test_postapplied_preflight_requires_complete_desired_state(self):
        self.backup()
        self.intent()
        (self.txn / "applied").write_text("yes")
        with self.assertRaises(native.Refusal):
            self.dispatch("preflight", str(self.txn), "founder-brief", self.schedule, self.prompt)
        self.ensure()
        self.dispatch("preflight", str(self.txn), "founder-brief", self.schedule, self.prompt)

    def test_cli_is_bound_to_default_profile_and_clears_inherited_origin(self):
        adapter = native.Adapter(str(self.home), "/example/hermes")
        with patch.dict(os.environ, {"HERMES_HOME": "/wrong", "HERMES_PROFILE": "wrong", "HERMES_SESSION_CHAT_ID": "private"}), patch.object(native.subprocess, "run") as run:
            run.return_value = types.SimpleNamespace(returncode=0)
            adapter.create(self.config)
        argv = run.call_args.args[0]
        self.assertEqual(argv[:5], ["/example/hermes", "--profile", "default", "cron", "create"])
        self.assertIn("--deliver=telegram", argv)
        self.assertEqual(sum(arg.startswith("--skill=") for arg in argv), 4)
        self.assertEqual(argv[-3:], ["--", self.schedule, self.prompt])
        env = run.call_args.kwargs["env"]
        self.assertEqual(env["HERMES_HOME"], str(self.home))
        self.assertEqual(env["HERMES_PROFILE"], "default")
        self.assertNotIn("HERMES_SESSION_CHAT_ID", env)

    def test_service_scope_rejects_external_profile_links_and_unknown_registry(self):
        self.dispatch("service-check")
        profiles = self.home / "profiles"
        profiles.mkdir()
        outside = Path(self.temp.name) / "external"
        outside.mkdir()
        (profiles / "external").symlink_to(outside)
        with self.assertRaises(native.Refusal):
            self.dispatch("service-check")
        (profiles / "external").unlink()
        state = self.home / "gateway_state.json"
        for payload in ({}, {"served_profiles": "default"}, {"served_profiles": ["coder"]}):
            state.write_text(json.dumps(payload))
            with self.assertRaises(native.Refusal):
                self.dispatch("service-check")

    def ready_payload(self, instance="new-instance"):
        fixture = Path(__file__).resolve().parents[1] / "fixtures/hermes-v0.22.5-ensure.contract.json"
        ready = json.loads(fixture.read_text())["result"]
        ready["endpoint"]["profile_id"] = str(self.home)
        ready["endpoint"]["instance_id"] = instance
        return ready

    def run_reload(self, handler, interrupt=False):
        """Run adapter.reload() with subprocess.run replaced by handler(argv) -> (returncode, payload or None)."""
        adapter = native.Adapter(str(self.home), "/example/hermes")
        calls = []
        def fake(argv, **kwargs):
            calls.append(argv[4:])
            code, payload = handler(argv[4:])
            return types.SimpleNamespace(returncode=code, stdout=b"" if payload is None else json.dumps(payload).encode())
        with patch.object(native.subprocess, "run", side_effect=fake), patch.object(native.time, "sleep"):
            try:
                with contextlib.redirect_stdout(io.StringIO()) as printed:
                    adapter.reload(interrupt_live_sessions=interrupt)
                return calls, None, printed.getvalue()
            except native.Refusal as refusal:
                return calls, refusal, ""

    def test_reload_requires_release_bound_machine_readiness(self):
        ready = self.ready_payload()
        old = self.ready_payload("old-instance")
        for payload, passes in ((ready, True), ({**ready, "state": "starting"}, False),
                                ({**ready, "endpoint": {**ready["endpoint"], "profile_id": "/foreign"}}, False),
                                ({**ready, "client_code_sha": "unreviewed"}, False)):
            calls, refusal, printed = self.run_reload(lambda argv: (0, old if argv[1:4] == ["--json", "--timeout", "10"] else (payload if argv[0] == "ensure" else None)))
            self.assertEqual(refusal is None, passes, payload.get("state"))
            # remember the instance, `restart --detach` (NO -y), readiness; never stop/start, never `run --daemon`
            self.assertEqual(calls, [["ensure", "--json", "--timeout", "10"], ["restart", "--detach"], ["ensure", "--json", "--timeout", "60"]])
            self.assertFalse(any("--daemon" in call or "-y" in call or call[:1] == ["run"] for call in calls))
            if passes:
                self.assertIn("native_gateway_reloaded=1", printed)

    def test_reload_adds_y_only_on_explicit_opt_in(self):
        ready, old = self.ready_payload(), self.ready_payload("old-instance")
        handler = lambda argv: (0, old if argv[3] == "10" else ready) if argv[0] == "ensure" else (0, None)
        calls, refusal, _ = self.run_reload(handler, interrupt=True)
        self.assertIsNone(refusal)
        self.assertEqual(calls[1], ["restart", "-y", "--detach"])
        calls, refusal, _ = self.run_reload(handler, interrupt=False)
        self.assertEqual(calls[1], ["restart", "--detach"])
        self.dispatch("service-check")
        with self.assertRaises(native.Refusal):
            self.dispatch("reload", "--interrupt-live-sessions", "extra")
        with self.assertRaises(native.Refusal):
            self.dispatch("service-check", "--interrupt-live-sessions")

    def test_reload_refused_restart_is_a_failure_and_readiness_is_not_consulted(self):
        old = self.ready_payload("old-instance")
        def refused(argv):
            return (0, old) if argv[0] == "ensure" else (1, None)
        calls, refusal, printed = self.run_reload(refused)
        self.assertEqual(refusal.detail, "native_restart_refused_or_failed")
        self.assertEqual(calls, [["ensure", "--json", "--timeout", "10"], ["restart", "--detach"]])
        self.assertNotIn("native_gateway_reloaded", printed)

    def test_reload_requires_a_new_instance_and_retries_only_transient_readiness(self):
        same = self.ready_payload("same-instance")
        calls, refusal, _ = self.run_reload(lambda argv: (0, same) if argv[0] == "ensure" else (0, None))
        self.assertEqual(refusal.detail, "native_instance_unchanged", "restart exited 0 but the gateway process did not change")
        # Without a baseline, success cannot prove that the gateway restarted.
        ready = self.ready_payload("fresh")
        calls, refusal, _ = self.run_reload(lambda argv: (1, None) if argv[:4] == ["ensure", "--json", "--timeout", "10"] else ((0, ready) if argv[0] == "ensure" else (0, None)))
        self.assertEqual(refusal.detail, "native_previous_instance_unconfirmed")
        self.assertEqual(calls, [["ensure", "--json", "--timeout", "10"]])
        for bad in ({**same, "state": "starting"}, {**same, "client_code_sha": "unreviewed"},
                    {**same, "endpoint": {**same["endpoint"], "profile_id": "/foreign"}}):
            calls, refusal, _ = self.run_reload(lambda argv: (0, bad))
            self.assertEqual(refusal.detail, "native_previous_instance_unconfirmed")
            self.assertEqual(calls, [["ensure", "--json", "--timeout", "10"]])
        # Native exit 6 retains a draining endpoint; it must still be compared.
        for next_instance, succeeds in (("same-instance", False), ("fresh", True)):
            def draining(argv):
                if argv[0] != "ensure":
                    return 0, None
                if argv[3] == "10":
                    return 6, {**same, "state": "draining"}
                return 0, self.ready_payload(next_instance)
            _, refusal, printed = self.run_reload(draining)
            self.assertEqual(refusal is None, succeeds)
            if not succeeds:
                self.assertEqual(refusal.detail, "native_instance_unchanged")
                self.assertNotIn("native_gateway_reloaded", printed)
        # exit 5/6 are transient (two retries); a third consecutive one fails; other non-zero codes are not retried
        for transient, expected_ok, expected_ready_calls in ((5, True, 3), (6, True, 3), (5, False, 3), (7, False, 1), (1, False, 1)):
            seen = {"n": 0}
            old = self.ready_payload("old-instance")
            def handler(argv, transient=transient, seen=seen, old=old):
                if argv[0] != "ensure":
                    return 0, None
                if argv[3] == "10":
                    return 0, old
                seen["n"] += 1
                if expected_ok and seen["n"] == 3:
                    return 0, ready
                return transient, {"state": "pending"}
            calls, refusal, _ = self.run_reload(handler)
            self.assertEqual(refusal is None, expected_ok, (transient, expected_ok))
            self.assertEqual(sum(call[:4] == ["ensure", "--json", "--timeout", "60"] for call in calls), expected_ready_calls, (transient, expected_ok))

    def test_reload_fails_closed_when_restart_fails_or_hangs_and_ensure_is_not_consulted(self):
        adapter = native.Adapter(str(self.home), "/example/hermes")
        for failure in (types.SimpleNamespace(returncode=1, stdout=b""), subprocess.TimeoutExpired("hermes", 120), OSError("gone")):
            def subprocess_result(argv, **kwargs):
                if argv[4] == "ensure":
                    return types.SimpleNamespace(returncode=0, stdout=json.dumps(self.ready_payload("old-instance")).encode())
                if isinstance(failure, BaseException):
                    raise failure
                return failure
            with patch.object(native.subprocess, "run", side_effect=subprocess_result) as run:
                with self.assertRaises(native.Refusal):
                    adapter.reload()
            self.assertEqual([call.args[0][4] for call in run.call_args_list], ["ensure", "restart"])
        calls = []
        old = self.ready_payload("old-instance")
        def readiness_hangs(argv, **kwargs):
            calls.append(argv[4])
            if argv[4] == "ensure" and argv[-1] == "60":
                raise subprocess.TimeoutExpired("hermes", 70)
            return types.SimpleNamespace(returncode=0, stdout=json.dumps(old).encode() if argv[4] == "ensure" else b"")
        with patch.object(native.subprocess, "run", side_effect=readiness_hangs), self.assertRaises(native.Refusal):
            adapter.reload()
        self.assertEqual(calls, ["ensure", "restart", "ensure"])


if __name__ == "__main__":
    unittest.main()
