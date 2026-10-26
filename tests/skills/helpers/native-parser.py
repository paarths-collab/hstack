"""Syntax-only harness around exact tagged upstream argparse builders.

No command handler is called. The injected modules are application boundaries,
not a replacement parser or evidence that Hermes runs on this host.
"""
import ast
import os
import re
import tempfile
from pathlib import Path
import contextlib
import importlib.util
import io
import json
import pathlib
import sys
import types

sys.dont_write_bytecode = True
root = pathlib.Path(sys.argv[1])
# `FIXTURE -- ARGV...` (used by stubs/hermes): check ONE invocation, print argparse's message to stderr and
# exit with its status; otherwise `FIXTURE JSON` prints a JSON result per invocation.
check_one = len(sys.argv) > 2 and sys.argv[2] == "--"
request = [sys.argv[3:]] if check_one else json.loads(sys.argv[2])
pkg = types.ModuleType("hermes_cli")
pkg.__path__ = [str(root)]
sys.modules["hermes_cli"] = pkg
sub = types.ModuleType("hermes_cli.subcommands")
sub.__path__ = [str(root / "subcommands")]
sys.modules["hermes_cli.subcommands"] = sub
constants = types.ModuleType("hermes_constants")
constants.display_hermes_home = str
profile_root = Path(tempfile.mkdtemp(prefix="hstack-native-profile-")) / ".hermes"
profile_root.mkdir()
(profile_root / "active_profile").write_text("work\n")
constants.get_default_hermes_root = lambda: profile_root
constants.get_process_hermes_home = lambda: pathlib.Path("/syntax-only-home")
constants.get_hermes_home = lambda: pathlib.Path("/syntax-only-home")
sys.modules["hermes_constants"] = constants
channels = types.ModuleType("hermes_cli.release_channels")
channels.validate_name = str  # Channel-name validity is outside this syntax test.
sys.modules["hermes_cli.release_channels"] = channels
runtime = types.ModuleType("hermes_cli.gateway_runtime_cli")
runtime.cmd_gateway_ensure = lambda args: None
sys.modules["hermes_cli.gateway_runtime_cli"] = runtime
migration = types.ModuleType("hermes_cli.left_core_migration")
migration.moved_command_hint = lambda prog, value: ""
sys.modules["hermes_cli.left_core_migration"] = migration

from hermes_cli._parser import build_top_level_parser
from hermes_cli.subcommands.config import build_config_parser
from hermes_cli.subcommands.gateway import build_gateway_parser
from hermes_cli.subcommands.memory import build_memory_parser
from hermes_cli.subcommands.model import build_model_parser
from hermes_cli.subcommands.setup import build_setup_parser
from hermes_cli.subcommands.update import build_update_parser
from hermes_cli.subcommands.cron import build_cron_parser
from hermes_cli.subcommands.backup import build_backup_parser
from hermes_cli.subcommands.import_cmd import build_import_cmd_parser
from hermes_cli.subcommands.skills import build_skills_parser
from hermes_cli.subcommands.mcp import build_mcp_parser
from hermes_cli.subcommands.doctor import build_doctor_parser
from hermes_cli.subcommands.logs import build_logs_parser
from hermes_cli.subcommands.pairing import build_pairing_parser
from hermes_cli.subcommands.sessions import build_sessions_parser
from hermes_cli.subcommands.status import build_status_parser
from hermes_cli.subcommands.plugins import build_plugins_parser
from hermes_cli.subcommands.profile import build_profile_parser
from hermes_cli.send_cmd import register_send_subparser

parser, subs, _ = build_top_level_parser()
handler = lambda args: None
build_config_parser(subs, cmd_config=handler)
build_gateway_parser(subs, cmd_gateway=handler, cmd_proxy=handler, cmd_gateway_enroll=handler)
build_memory_parser(subs, cmd_memory=handler)
build_model_parser(subs, cmd_model=handler)
build_setup_parser(subs, cmd_setup=handler)
build_update_parser(subs, cmd_update=handler)
build_cron_parser(subs, cmd_cron=handler)
build_backup_parser(subs, cmd_backup=handler)
build_import_cmd_parser(subs, cmd_import=handler)
build_skills_parser(subs, cmd_skills=handler)
build_mcp_parser(subs, cmd_mcp=handler)
build_doctor_parser(subs, cmd_doctor=handler)
build_logs_parser(subs, cmd_logs=handler)
build_pairing_parser(subs, cmd_pairing=handler)
build_sessions_parser(subs, cmd_sessions=handler)
build_status_parser(subs, cmd_status=handler)
build_plugins_parser(subs, cmd_plugins=handler)
build_profile_parser(subs, cmd_profile=handler)
register_send_subparser(subs)
# Execute only actual tagged early profile functions, never main.py imports or handlers.
# Home resolution and service presence are injected boundaries; selection/flag stripping are real.
profiles = types.ModuleType("hermes_cli.profiles")
profiles.resolve_profile_env = lambda name: str(profile_root if name == "default" else profile_root / "profiles" / name)
sys.modules["hermes_cli.profiles"] = profiles
service_manager = types.ModuleType("hermes_cli.service_manager")
service_manager._s6_running = lambda: False
sys.modules["hermes_cli.service_manager"] = service_manager
_startup_fast = types.SimpleNamespace(is_desktop_ssh_backend_argv=lambda argv: False)
names = {"_inside_mcp_add_args", "_looks_like_hermes_invocation", "_exit_invalid_profile_name", "_looks_like_option_value", "_scan_profile_flag", "_under_gateway_supervisor", "_s6_supervised_gateway_run", "_apply_profile_override"}
source = ast.parse((root / "main.py").read_text())
nodes = [n for n in source.body if isinstance(n, ast.FunctionDef) and n.name in names or isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "_PROFILE_NAME_RE" for t in n.targets)]
exec(compile(ast.Module(body=nodes, type_ignores=[]), str(root / "main.py"), "exec"), globals())
result = []
for argv in request:
    os.environ["HERMES_HOME"] = str(profile_root)
    for key in ["HERMES_SUPERVISED_CHILD", "HERMES_S6_SUPERVISED_CHILD", "INVOCATION_ID", "HERMES_GATEWAY_EXTERNAL_SUPERVISOR"]:
        os.environ.pop(key, None)
    sys.argv = ["hermes", *argv]
    _apply_profile_override()
    output = io.StringIO()
    try:
        with contextlib.redirect_stderr(output), contextlib.redirect_stdout(output):
            args = vars(parser.parse_args(sys.argv[1:]))
        result.append({"argv": argv, "code": 0, "selected_profile": Path(os.environ["HERMES_HOME"]).name, "explicit_profile": _explicit_cli_profile, "args": {k: v for k, v in args.items() if not callable(v)}})
    except SystemExit as exc:
        result.append({"argv": argv, "code": exc.code, "output": output.getvalue()})
import shutil
shutil.rmtree(profile_root.parent)
if check_one:
    row = result[0]
    if row["code"] != 0:
        sys.stderr.write(row.get("output") or "hermes: invalid invocation\n")
        sys.exit(row["code"] if isinstance(row["code"], int) else 2)
    sys.exit(0)
print(json.dumps(result))
