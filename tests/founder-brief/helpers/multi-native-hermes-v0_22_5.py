#!/usr/bin/env python3
"""Offline native CLI fixture; its atomic jobstore models native serialization.

Only the fixture writes its jobstore. Deployment tests exercise public commands
and the production read-only parser, including parallel independent instances.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import sys
import tempfile
import uuid

home = Path(os.environ["HERMES_HOME"])
args = sys.argv[1:]
if args == ["--profile", "default", "--version"]:
    # Real v0.22.5 multi-line format (hermes_cli/_startup_fast.py print_fast_version_info).
    sys.stdout.buffer.write(("Hermes Agent v0.22.5 (2026.9.24) \u00b7 upstream bf0203a7\nInstall directory: /home/operator/.hermes/hermes-agent\n"
                             "Install method: git\nPython: 3.11.16\nOpenAI SDK: 2.24.0\n").encode("utf-8"))
    sys.exit()
if args[:2] != ["--profile", "default"]:
    sys.exit(90)
args = args[2:]
if args[:2] == ["gateway", "ensure"]:
    commit = "bf0203a794a07aac3ff764972ab9087baa4e4f4e"
    print(json.dumps({"state": "ready", "client_code_sha": commit,
                      "endpoint": {"profile_id": str(home), "control_home": None,
                                   "supervisor": "systemd", "runtime_protocol": 1,
                                   "authority_epoch": 1, "instance_id": "offline-fixture", "code_sha": commit}}))
    sys.exit()
if args[:1] != ["cron"]:
    sys.exit(91)
store = home / "cron/jobs.json"
store.parent.mkdir(exist_ok=True)
with (home / "fixture-native-store.lock").open("a") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    data = json.loads(store.read_text()) if store.exists() else {"jobs": []}
    if args[1] == "create":
        parser = argparse.ArgumentParser()
        parser.add_argument("schedule")
        parser.add_argument("prompt", nargs="?")
        for key in ("name", "deliver", "failure-deliver", "script"):
            parser.add_argument("--" + key)
        parser.add_argument("--no-agent", action="store_true")
        values = vars(parser.parse_args(args[2:]))
        if os.environ.get("BRIEF_FAIL_INSTANCE") == values["name"]:
            sys.exit(1)
        data["jobs"].append({"id": "created-" + uuid.uuid4().hex,
                             "name": values["name"], "prompt": values["prompt"],
                             "schedule": {"kind": "cron", "expr": values["schedule"]},
                             "repeat": {"times": None, "completed": 0}, "skills": [],
                             "no_agent": values["no_agent"], "script": values["script"],
                             "deliver": values["deliver"], "failure_deliver": values["failure_deliver"],
                             "enabled": True, "state": "scheduled"})
    elif args[1] == "remove":
        data["jobs"] = [job for job in data["jobs"] if job["id"] != args[2]]
    else:
        sys.exit(92)
    fd, temporary = tempfile.mkstemp(dir=store.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(data, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, store)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
