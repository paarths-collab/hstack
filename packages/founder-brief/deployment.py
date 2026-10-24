"""Private, first-install-only deployment for the reviewed deterministic brief.

Scheduling belongs to the tagged native Hermes CLI; this module never edits
jobs.json, .env, global config, or restarts a gateway. Runtime delivery belongs to
the reviewed bundle. Its mutable state and this private receipt survive rollback.
"""
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import threading
import uuid

import native_adapter

try:
    from instance_scope import scope_for
except ModuleNotFoundError:
    # Source-only test tools load this module by path under Python -I. The
    # packaged runtime imports the same module normally from its zipapp.
    _scope_spec = importlib.util.spec_from_file_location("instance_scope", Path(__file__).with_name("instance_scope.py"))
    _scope_module = importlib.util.module_from_spec(_scope_spec)
    sys.modules["instance_scope"] = _scope_module
    _scope_spec.loader.exec_module(_scope_module)
    scope_for = _scope_module.scope_for

VERSION = native_adapter.VERSION
COMMIT = native_adapter.COMMIT
OWNER = "hstack-founder-brief-v1"
MARKER = "[hstack:founder-brief]"
SCRIPT = "hstack-founder-brief.py"
PROMPT = "Run reviewed GitHub daily brief " + MARKER
CONFIG_KEYS = {"schema_version", "repositories", "telegram_chat_id", "daily_time", "timezone", "window_hours"}
CREDENTIAL_KEYS = {"GITHUB_TOKEN", "TELEGRAM_BOT_TOKEN"}
MAX_BUNDLE = 8 * 1024 * 1024


class DeploymentError(Exception):
    """Fixed, secret-free diagnostics only; never expose subprocess output."""
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def refuse(code):
    raise DeploymentError(code)


def encoded(value):
    try:
        return (json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")
    except (TypeError, ValueError, RecursionError):
        refuse("invalid_input")


def sha(value):
    return hashlib.sha256(value).hexdigest()


def validate_config(config):
    # One shared input grammar for CLI review, deployment and scheduled workers.
    from workflow import WorkflowError, validate_config as shared_validation
    try:
        return shared_validation(config)
    except WorkflowError:
        refuse("invalid_config")


def validate_credentials(credentials):
    from workflow import WorkflowError, validate_credentials as shared_validation
    try:
        return encoded(shared_validation(credentials))
    except WorkflowError:
        refuse("invalid_credentials")


def desired_job(instance_id=None):
    scope = scope_for(instance_id)
    prompt = "Run reviewed GitHub daily brief " + scope.marker
    config = dict.fromkeys(native_adapter.FIELDS)
    config.update(name=scope.marker, prompt=prompt, schedule={"kind": "cron", "expr": "* * * * *"},
                  skills=[], script=scope.script, no_agent=True, repeat={"times": None}, enabled=True,
                  deliver="local", failure_deliver="local")
    return config


class Deployment:
    def __init__(self, home, hermes, *, offline=False, instance_id=None):
        self.scope = scope_for(instance_id)
        self.instance_id = self.scope.instance_id
        if not offline and sys.platform != "linux":
            refuse("linux_target_required")
        if (not isinstance(hermes, (str, Path)) or not os.path.isabs(str(hermes))
                or str(hermes) != os.path.normpath(str(hermes))
                or any(ord(char) < 32 or ord(char) == 127 for char in str(hermes))):
            refuse("unsafe_hermes_path")
        try:
            self.native = native_adapter.Adapter(str(home), str(hermes))
        except native_adapter.Refusal:
            refuse("unsafe_target")
        self.home = self.native.home
        self._check_home()
        self.hermes = str(hermes)
        self.parent = self.home / ".hstack"
        self.root = self.home / self.scope.relative_root
        self.scripts = self.home / "scripts"
        self.launcher = self.scripts / self.scope.script
        self.receipt = self.root / "installation.json"
        self._lock_fd = None
        self._lock_thread = None

    def review_descriptor(self, bundle_bytes, launcher_bytes, config):
        if (not isinstance(bundle_bytes, bytes) or not 1 <= len(bundle_bytes) <= MAX_BUNDLE
                or not isinstance(launcher_bytes, bytes) or not 1 <= len(launcher_bytes) <= 65536):
            refuse("invalid_artifact")
        config = self._validated_config(config)
        return {"schema_version": 1, "workflow": self.scope.owner, "home": str(self.home), "hermes": self.hermes,
                "hermes_version": VERSION, "hermes_commit": COMMIT,
                "runtime_sha256": sha(bundle_bytes), "launcher_sha256": sha(launcher_bytes),
                "config": config, "credential_keys": sorted(CREDENTIAL_KEYS),
                "native_job": desired_job(self.instance_id)}

    def _validated_config(self, config):
        value = validate_config(config)
        if (self.instance_id is None and "instance_id" in value) or value.get("instance_id") != self.instance_id:
            refuse("instance_config_mismatch")
        return value

    def review_hash(self, bundle_bytes, launcher_bytes, config):
        return sha(encoded(self.review_descriptor(bundle_bytes, launcher_bytes, config)))

    @staticmethod
    def _directory(path, create=False):
        try:
            info = path.lstat()
        except FileNotFoundError:
            if not create:
                return False
            try:
                path.mkdir(mode=0o700)
                return True
            except FileExistsError:
                # Other instances can create shared containers concurrently.
                info = path.lstat()
        if not stat.S_ISDIR(info.st_mode):
            refuse("unsafe_path")
        return True

    def _check_home(self):
        try:
            info = self.home.lstat()
        except OSError:
            refuse("unsafe_target")
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) & 0o022):
            refuse("unsafe_target")

    def _scope_directories(self, create=False):
        # A protected child can still be replaced through a writable home.
        # Recheck before opening locks and again during runtime validation.
        self._check_home()
        present = self._directory(self.parent, create=create)
        if present:
            info = self.parent.lstat()
            if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o022:
                refuse("owned_directory_drift")
        if self.instance_id is not None:
            container = self.parent / "workflows"
            if self._directory(container, create=create):
                info = container.lstat()
                if stat.S_IMODE(info.st_mode) != 0o700 or info.st_uid != os.geteuid():
                    refuse("owned_directory_drift")

    @contextmanager
    def _lock(self):
        if self._lock_fd is not None:
            if self._lock_thread != threading.get_ident():
                refuse("deployment_busy")
            yield
            return
        self._scope_directories(create=True)
        lock = self.parent / self.scope.lock_name
        try:
            fd = os.open(str(lock), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        except OSError:
            refuse("unsafe_lock")
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.geteuid() or info.st_nlink != 1:
                refuse("unsafe_lock")
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                refuse("deployment_busy")
            named = lock.lstat()
            if named.st_ino != info.st_ino or named.st_dev != info.st_dev:
                refuse("unsafe_lock")
            self._lock_fd = fd
            self._lock_thread = threading.get_ident()
            yield
        finally:
            self._lock_fd = None
            self._lock_thread = None
            os.close(fd)  # kernel releases even after SIGKILL; never unlink locks

    @staticmethod
    def _file(path):
        try:
            info = path.lstat()
        except FileNotFoundError:
            return None
        if (not stat.S_ISREG(info.st_mode) or info.st_size > MAX_BUNDLE
                or info.st_uid != os.geteuid() or info.st_nlink != 1):
            refuse("unsafe_path")
        try:
            fd = os.open(str(path), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
            with os.fdopen(fd, "rb") as stream:
                opened = os.fstat(stream.fileno())
                if not stat.S_ISREG(opened.st_mode) or opened.st_ino != info.st_ino or opened.st_dev != info.st_dev:
                    refuse("unsafe_path")
                data = stream.read(MAX_BUNDLE + 1)
            if len(data) > MAX_BUNDLE:
                refuse("unsafe_path")
            return data, stat.S_IMODE(info.st_mode)
        except OSError:
            refuse("unsafe_path")

    def _read_receipt(self):
        found = self._file(self.receipt)
        if found is None:
            return None
        if found[1] != 0o600:
            refuse("receipt_drift")
        try:
            receipt = json.loads(found[0], object_pairs_hook=native_adapter.unique_pairs)
            proof = receipt.pop("receipt_sha256")
            if proof != sha(encoded(receipt)) or receipt["owner"] != self.scope.owner or receipt["home"] != str(self.home):
                refuse("receipt_drift")
            expected_fields = {"schema_version", "owner", "home", "hermes", "installation_id", "installed_at", "phase",
                               "plan_hash", "review_hash", "native_job", "baseline_job_ids", "job_id", "files"}
            if (set(receipt) != expected_fields or receipt["schema_version"] != 1 or receipt["native_job"] != desired_job(self.instance_id)
                    or receipt["hermes"] != self.hermes
                    or receipt["phase"] not in {"installing", "create_intended", "complete", "rolled_back"}
                    or not isinstance(receipt["installation_id"], str)
                    or not re.fullmatch(r"[a-f0-9]{32}", receipt["installation_id"])
                    or not isinstance(receipt["installed_at"], str)
                    or datetime.fromisoformat(receipt["installed_at"]).utcoffset() is None
                    or any(not isinstance(receipt[key], str) or not re.fullmatch(r"[a-f0-9]{64}", receipt[key]) for key in ("plan_hash", "review_hash"))
                    or (receipt["job_id"] is not None and (not isinstance(receipt["job_id"], str) or not native_adapter.ID.fullmatch(receipt["job_id"])))
                    or not isinstance(receipt["baseline_job_ids"], list)
                    or any(not isinstance(value, str) or not native_adapter.ID.fullmatch(value) for value in receipt["baseline_job_ids"])
                    or len(set(receipt["baseline_job_ids"])) != len(receipt["baseline_job_ids"])
                    or not isinstance(receipt["files"], dict)
                    or set(receipt["files"]) != {"launcher", "runtime", "config", "credentials"}):
                refuse("receipt_drift")
            for key, entry in receipt["files"].items():
                if (not isinstance(entry, dict) or set(entry) != {"sha256", "mode"}
                        or not isinstance(entry["sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", entry["sha256"])
                        or type(entry["mode"]) is not int or entry["mode"] != (0o700 if key == "launcher" else 0o600)):
                    refuse("receipt_drift")
            return receipt
        except (ValueError, KeyError, TypeError, AttributeError, native_adapter.Refusal):
            refuse("receipt_drift")

    @staticmethod
    def _atomic(path, data, mode, *, replace=True):
        if path.is_symlink():
            refuse("unsafe_path")
        fd, temporary = tempfile.mkstemp(prefix=".hstack-brief-", dir=str(path.parent))
        try:
            os.fchmod(fd, mode)
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            if replace:
                os.replace(temporary, path)
            else:
                # Atomic no-clobber publication: an operator creating a file
                # between preflight and publish keeps their bytes.
                os.link(temporary, path)
            directory = os.open(str(path.parent), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def _write_receipt(self, receipt):
        payload = dict(receipt, receipt_sha256=sha(encoded(receipt)))
        self._atomic(self.receipt, encoded(payload), 0o600)

    def _paths(self):
        return {"launcher": self.launcher, "runtime": self.root / "runtime.pyz",
                "config": self.root / "config.json", "credentials": self.root / "credentials.json"}

    def _structure(self):
        self._scope_directories()
        if self._directory(self.scripts):
            info = self.scripts.lstat()
            if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o022:
                refuse("owned_directory_drift")
        if self._directory(self.root):
            if stat.S_IMODE(self.root.stat().st_mode) != 0o700 or self.root.stat().st_uid != os.geteuid():
                refuse("owned_directory_drift")
            self._directory(self.root / "state")
            if (self.root / "state").exists():
                info = (self.root / "state").stat()
                if stat.S_IMODE(info.st_mode) != 0o700 or info.st_uid != os.geteuid():
                    refuse("owned_directory_drift")
            if any(path.name not in {"runtime.pyz", "config.json", "credentials.json", "installation.json", "state"}
                   for path in self.root.iterdir()):
                refuse("unmanaged_files_present")

    def _verify_files(self, receipt, allow_missing=False):
        self._structure()
        for key, path in self._paths().items():
            found = self._file(path)
            if found is None and allow_missing:
                continue
            expected = receipt["files"][key]
            if found is None or sha(found[0]) != expected["sha256"] or found[1] != expected["mode"]:
                refuse("owned_file_drift")
            if key == "config":
                try:
                    self._validated_config(json.loads(found[0], object_pairs_hook=native_adapter.unique_pairs))
                except (ValueError, TypeError, native_adapter.Refusal):
                    refuse("invalid_config")

    def _jobs(self):
        try:
            return self.native.jobs()
        except native_adapter.Refusal:
            refuse("native_store_refused")

    def _owned_job(self, receipt):
        marked = [job for job in self._jobs() if job["managed_id"] == self.scope.managed_id
                  or job["id"] == receipt.get("job_id") or job["config"].get("script") == self.scope.script]
        if not marked:
            return None
        if (len(marked) != 1 or marked[0]["config"] != desired_job(self.instance_id)
                or marked[0]["id"] in receipt["baseline_job_ids"]
                or receipt.get("job_id") not in {None, marked[0]["id"]}):
            refuse("native_job_drift")
        return marked[0]

    def _run(self, args, *, output=False, timeout=120):
        try:
            result = subprocess.run([self.hermes] + args, env=self.native.environment(), stdin=subprocess.DEVNULL,
                                    stdout=subprocess.PIPE if output else subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL, timeout=timeout, check=False)
        except (OSError, subprocess.SubprocessError):
            refuse("native_cli_unconfirmed")
        if result.returncode != 0:
            refuse("native_cli_unconfirmed")
        if output and len(result.stdout) > 65536:
            refuse("native_cli_unconfirmed")
        return result.stdout if output else None

    def _ready(self):
        try:
            self.native.service_check()
        except native_adapter.Refusal:
            refuse("native_scope_refused")
        version = self._run(["--profile", "default", "--version"], output=True).decode("utf-8", errors="replace")
        if re.findall(r"(?<![0-9])[0-9]+\.[0-9]+\.[0-9]+(?![0-9])", version) != [VERSION]:
            refuse("native_version_mismatch")
        payload = self._run(["--profile", "default", "gateway", "ensure", "--json", "--timeout", "60"], output=True, timeout=70)
        try:
            ready = json.loads(payload, object_pairs_hook=native_adapter.unique_pairs)
        except (ValueError, TypeError, native_adapter.Refusal):
            refuse("native_readiness_unconfirmed")
        endpoint = ready.get("endpoint") if isinstance(ready, dict) else None
        if (not isinstance(endpoint, dict) or ready.get("state") != "ready"
                or endpoint.get("profile_id") != str(self.home) or endpoint.get("control_home") not in {None, str(self.home)}
                or endpoint.get("supervisor") != "systemd" or type(endpoint.get("runtime_protocol")) is not int
                or endpoint.get("runtime_protocol") != 1 or type(endpoint.get("authority_epoch")) is not int
                or endpoint["authority_epoch"] <= 0 or not isinstance(endpoint.get("instance_id"), str)
                or not endpoint["instance_id"] or endpoint.get("code_sha") != COMMIT or ready.get("client_code_sha") != COMMIT):
            refuse("native_readiness_mismatch")
        try:
            self.native.service_check()
        except native_adapter.Refusal:
            refuse("native_scope_refused")

    def install(self, bundle_bytes, launcher_bytes, config, credentials):
        descriptor = self.review_descriptor(bundle_bytes, launcher_bytes, config)
        values = {"launcher": launcher_bytes, "runtime": bundle_bytes,
                  "config": encoded(descriptor["config"]), "credentials": validate_credentials(credentials)}
        files = {key: {"sha256": sha(value), "mode": 0o700 if key == "launcher" else 0o600} for key, value in values.items()}
        plan_hash = sha(encoded({"review": descriptor, "files": files}))
        with self._lock():
            self._structure()
            receipt = self._read_receipt() if self.root.exists() else None
            if receipt is not None:
                if receipt["phase"] == "rolled_back" or receipt.get("plan_hash") != plan_hash or receipt["files"] != files:
                    refuse("existing_plan_requires_review")
                self._verify_files(receipt, allow_missing=receipt["phase"] != "complete")
                job = self._owned_job(receipt)
                if receipt["phase"] == "complete":
                    if job is None:
                        refuse("native_job_drift")
                    self._ready()
                    return {"status": "unchanged", "job_id": job["id"], "review_hash": sha(encoded(descriptor))}
            else:
                if (self.launcher.exists() or self.launcher.is_symlink()
                        or (self.root.exists() and any(self.root.iterdir()))
                        or any(job["managed_id"] == self.scope.managed_id
                               or job["config"].get("script") == self.scope.script for job in self._jobs())):
                    refuse("existing_workflow_requires_review")
                job = None
            self._ready()
            if receipt is None:
                self._directory(self.root, create=True)
                self._directory(self.root / "state", create=True)
                receipt = {"schema_version": 1, "owner": self.scope.owner, "home": str(self.home), "hermes": self.hermes,
                           "installation_id": uuid.uuid4().hex, "installed_at": datetime.now(timezone.utc).isoformat(),
                           "phase": "installing", "plan_hash": plan_hash, "review_hash": sha(encoded(descriptor)),
                           "native_job": desired_job(self.instance_id), "baseline_job_ids": [job["id"] for job in self._jobs()],
                           "job_id": None, "files": files}
                self._write_receipt(receipt)
            try:
                self._directory(self.scripts, create=True)
                for key, path in self._paths().items():
                    if self._file(path) is None:
                        self._atomic(path, values[key], files[key]["mode"], replace=False)
                self._verify_files(receipt)
                if job is None:
                    receipt["phase"] = "create_intended"
                    self._write_receipt(receipt)
                    creation_failed = False
                    try:
                        self._run(["--profile", "default", "cron", "create", "--script=" + self.scope.script, "--no-agent",
                                   "--deliver=local", "--failure-deliver=local", "--name=" + self.scope.marker,
                                   "--", "* * * * *", "Run reviewed GitHub daily brief " + self.scope.marker])
                    except DeploymentError:
                        creation_failed = True
                    job = self._owned_job(receipt)
                    if job is None:
                        refuse("native_create_unconfirmed" if creation_failed else "native_create_not_observed")
                receipt.update(phase="complete", job_id=job["id"])
                self._write_receipt(receipt)
                return {"status": "installed", "job_id": job["id"], "review_hash": receipt["review_hash"]}
            except (DeploymentError, OSError):
                # Fixed-code cleanup never overwrites a user edit. On conflict the
                # private receipt/payload remain available for explicit recovery.
                try:
                    self._cleanup(receipt)
                except (DeploymentError, OSError):
                    refuse("install_cleanup_requires_review")
                refuse("install_failed_cleaned")

    def _cleanup(self, receipt):
        self._verify_files(receipt, allow_missing=True)
        job = self._owned_job(receipt)
        if job is not None:
            try:
                self._run(["--profile", "default", "cron", "remove", job["id"]])
            except DeploymentError:
                # A lost response after remove is reconciled by exact identity.
                pass
            if self._owned_job(receipt) is not None:
                refuse("native_remove_unconfirmed")
        for key, path in self._paths().items():
            found = self._file(path)
            if found is not None:
                expected = receipt["files"][key]
                if sha(found[0]) != expected["sha256"] or found[1] != expected["mode"]:
                    refuse("owned_file_drift")
                path.unlink()
        receipt["phase"] = "rolled_back"
        self._write_receipt(receipt)

    def rollback(self):
        with self._lock():
            self._structure()
            receipt = self._read_receipt() if self.root.exists() else None
            if receipt is None:
                refuse("owned_installation_required")
            if receipt["phase"] == "rolled_back":
                if any(self._file(path) is not None for path in self._paths().values()) or self._owned_job(receipt) is not None:
                    refuse("rolled_back_installation_drift")
                return {"status": "already_rolled_back", "evidence_retained": True}
            self._ready()
            self._cleanup(receipt)
            return {"status": "rolled_back", "evidence_retained": True}

    def verify_installation(self, verify_job=False):
        """Validate complete installed bytes; retain runtime_guard during sends."""
        with self._lock():
            self._structure()
            receipt = self._read_receipt() if self.root.exists() else None
            if receipt is None or receipt["phase"] != "complete":
                refuse("complete_installation_required")
            self._verify_files(receipt)
            if verify_job and self._owned_job(receipt) is None:
                refuse("native_job_drift")
            return receipt

    @contextmanager
    def runtime_guard(self):
        """Hold the deployment/rollback lock through collection and Telegram send.

        This has no native CLI/service calls. A scheduled worker cannot race a
        rollback into sending after its credentials or reviewed code are retired.
        """
        with self._lock():
            yield self.verify_installation()
