"""Prepare one private workflow pack without JSON editing or network access.

This command prepares files for an existing, separately provisioned Hermes target.
It does not transfer files, supply credentials, install a job or send a message.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shlex
import stat
import sys

WORKFLOWS = ("activity-brief", "review-queue", "release-watch")
MAX_RUNTIME = 8 * 1024 * 1024


class PreparationError(Exception):
    """Fixed diagnostics only; never echo file contents or process exceptions."""


def source_module(name):
    """Load trusted checkout siblings even when Python's -I omits their directory."""
    sibling = Path(__file__).with_name(name + ".py")
    if sibling.is_file():
        specification = importlib.util.spec_from_file_location(
            "hstack_prepare_" + name, sibling)
        if specification is None or specification.loader is None:
            raise PreparationError("preparation_source_unavailable") from None
        module = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(module)
        return module
    # In the self-contained zipapp, these imports resolve within its reviewed archive.
    return __import__(name)


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"),
                       ensure_ascii=True, allow_nan=False) + "\n").encode()


def commands():
    directory = "<TARGET_PREPARED_DIRECTORY>"
    runtime = directory + "/runtime.pyz"
    config = directory + "/config.json"
    prefix = ["python3", "-I", "-B", runtime]
    target = ["--home", "<TARGET_HERMES_HOME>", "--hermes", "<TARGET_HERMES_EXECUTABLE>"]
    credentials = ["--credentials", "<TARGET_CREDENTIALS_JSON>"]
    approval = ["--approve", "<REVIEWED_PLAN_HASH>"]
    arguments = {
        "credentials": prefix + ["credentials", "--output", "<TARGET_CREDENTIALS_JSON>"],
        "preview": prefix + ["preview", "--config", config] + credentials,
        "review": prefix + ["review"] + target + ["--config", config],
        "install": prefix + ["install"] + target + ["--config", config] + credentials + approval,
        "canary": prefix + ["canary", "--home", "<TARGET_HERMES_HOME>"] + approval,
    }
    return {name: {"argv": argv, "shell": shlex.join(argv)} for name, argv in arguments.items()}


def instructions(config, next_commands):
    lines = [
        "# Prepared hstack workflow", "",
        "Prepared only: nothing has been transferred, installed or sent.",
        "One selected workflow is supported per exclusive default-profile target.", "",
        "Workflow: `" + config["workflow"] + "`.",
        "Daily cutoff: `" + config["daily_time"] + "` in `" + config["timezone"] + "`.",
        "Reporting window: `" + str(config["window_hours"]) + "` hours; the review queue is a current snapshot.", "",
        "1. Inspect config.json and the reviewed source checkout used to build runtime.pyz.",
        "2. Transfer runtime.pyz and config.json over your existing trusted route to a private directory on the Linux target.",
        "3. Run the credentials command below on an interactive target terminal. It captures hidden token input into a new mode-600 file inside a private mode-700 directory outside the repository; no JSON editing is required.",
        "   credentials.example.json is optional reference only. It contains an invalid placeholder, not usable credentials.",
        "   The bot token is required. GITHUB_TOKEN may be empty for public repositories. Start the bot in the intended private chat first.",
        "4. Replace every angle-bracket placeholder below with the corresponding absolute target path or reviewed hash.",
        "   Preview reads GitHub only; review prints a plan. Installation and the canary are separate explicit operations.",
        "5. After credentials capture, run preview, inspect the actual report, then review. Pass the printed plan_hash to install and canary.",
        "6. Observe the actual Telegram message separately. An API acknowledgement is not evidence that a person read it.", "",
        "The target must already run the exact supported Hermes candidate, its installed systemd gateway, Python 3.9+ with timezone data and an exclusive default profile.",
        "Preparation does not install or upgrade these prerequisites. Existing deployments require migration review.", "",
    ]
    for name, command in next_commands.items():
        lines.extend(["## " + name, "", "```bash", command["shell"], "```", ""])
    return ("\n".join(lines) + "\n").encode()


def write_output(output, contents):
    """Publish a new private directory without following or replacing its entries."""
    output = Path(os.path.abspath(os.fspath(output)))
    if output.name in {"", ".", ".."}:
        raise PreparationError("invalid_output_path")
    parent_fd = directory_fd = None
    made_directory = None
    written = {}
    try:
        try:
            parent_fd = os.open(str(output.parent), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        except FileNotFoundError:
            raise PreparationError("output_parent_missing") from None
        except OSError:
            raise PreparationError("unsafe_output_parent") from None
        parent = os.fstat(parent_fd)
        # A private output beneath a trusted sticky temporary root is also safe.
        sticky_root = parent.st_uid == 0 and bool(parent.st_mode & stat.S_ISVTX)
        if ((parent.st_uid != os.getuid() and not sticky_root)
                or (parent.st_mode & 0o022 and not sticky_root)):
            raise PreparationError("unsafe_output_parent")
        try:
            os.mkdir(output.name, mode=0o700, dir_fd=parent_fd)
        except FileExistsError:
            raise PreparationError("output_already_exists") from None
        made_directory = os.stat(output.name, dir_fd=parent_fd, follow_symlinks=False)
        os.chmod(output.name, 0o700, dir_fd=parent_fd, follow_symlinks=False)
        directory_fd = os.open(output.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
        opened = os.fstat(directory_fd)
        if (opened.st_dev, opened.st_ino) != (made_directory.st_dev, made_directory.st_ino):
            raise PreparationError("output_directory_changed")
        os.fchmod(directory_fd, 0o700)
        for name, (data, mode) in contents.items():
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=directory_fd)
            written[name] = os.fstat(fd)
            with os.fdopen(fd, "wb") as stream:
                os.fchmod(stream.fileno(), mode)
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
        os.fsync(directory_fd)
        os.fsync(parent_fd)
        return output
    except Exception:
        # Clean up only entries we created, and only while their inode still matches.
        if directory_fd is not None:
            for name, prior in written.items():
                try:
                    current = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                    if (current.st_dev, current.st_ino) == (prior.st_dev, prior.st_ino):
                        os.unlink(name, dir_fd=directory_fd)
                except OSError:
                    pass
        if made_directory is not None:
            try:
                current = os.stat(output.name, dir_fd=parent_fd, follow_symlinks=False)
                if (current.st_dev, current.st_ino) == (made_directory.st_dev, made_directory.st_ino):
                    os.rmdir(output.name, dir_fd=parent_fd)
            except OSError:
                pass
        raise
    finally:
        if directory_fd is not None:
            os.close(directory_fd)
        if parent_fd is not None:
            os.close(parent_fd)


def main(argv=None, runtime_bytes=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workflow", choices=WORKFLOWS, required=True)
    parser.add_argument("--repository", action="append", required=True,
                        help="Selected owner/repository; repeat for up to eight repositories")
    parser.add_argument("--chat-id", required=True, help="Positive private Telegram chat ID")
    parser.add_argument("--at", default="09:00", help="Daily local cutoff in HH:MM (default: 09:00)")
    parser.add_argument("--timezone", default="UTC", help="IANA timezone (default: UTC)")
    parser.add_argument("--window-hours", type=int, default=24, help="Reporting window, 1–168 (default: 24)")
    parser.add_argument("--output", type=Path, required=True, help="A new private directory; existing paths are refused")
    args = parser.parse_args(argv)
    try:
        workflow = source_module("workflow")
        config = workflow.validate_config({
            "schema_version": 1, "workflow": args.workflow, "repositories": args.repository,
            "telegram_chat_id": args.chat_id, "daily_time": args.at,
            "timezone": args.timezone, "window_hours": args.window_hours,
        })
        runtime = source_module("build").build() if runtime_bytes is None else runtime_bytes
        if not isinstance(runtime, bytes) or not 1 <= len(runtime) <= MAX_RUNTIME:
            raise PreparationError("invalid_runtime")
        next_commands = commands()
        contents = {
            "runtime.pyz": (runtime, 0o700),
            "config.json": (encoded(config), 0o600),
            "credentials.example.json": (encoded({"GITHUB_TOKEN": "", "TELEGRAM_BOT_TOKEN": "REPLACE_WITH_PRIVATE_BOT_TOKEN"}), 0o600),
            "NEXT_STEPS.md": (instructions(config, next_commands), 0o600),
        }
        output = write_output(args.output, contents)
        result = {
            "status": "prepared", "workflow": config["workflow"], "configuration": config,
            "runtime_sha256": hashlib.sha256(runtime).hexdigest(),
            "files": {key: str(output / name) for key, name in {
                "runtime": "runtime.pyz", "config": "config.json",
                "credentials_example": "credentials.example.json", "instructions": "NEXT_STEPS.md"}.items()},
            "next_commands": next_commands, "target_transfer_required": True,
            "scope": "one_selected_workflow_per_default_target", "evidence_scope": "offline_preparation_only",
        }
        print(encoded(result).decode(), end="")
        return 0
    except Exception as error:
        workflow_error = getattr(locals().get("workflow"), "WorkflowError", None)
        known = isinstance(error, PreparationError) or (workflow_error is not None and isinstance(error, workflow_error))
        code = str(error) if known else "preparation_failed"
        print(encoded({"status": "unprepared", "error": code}).decode(), end="", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
