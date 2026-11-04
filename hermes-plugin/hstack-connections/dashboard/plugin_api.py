"""Scoped Hermes backend for the Hstack Desktop prototype."""
import asyncio
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import hashlib
import signal
from typing import Optional

from fastapi import APIRouter, HTTPException, Request

router = APIRouter()
PROVIDERS = frozenset({"buffer", "pallyy", "metricool", "blotato", "ayrshare"})



def run_bridge(request: dict, state_dir: Optional[str] = None) -> dict:
    if request["action"] not in {"status", "save", "test", "disconnect", "activate", "deactivate", "migrate"}:
        raise HTTPException(status_code=400, detail="Unsupported operation.")
    # This operator-supplied path is server configuration, never input from the UI.
    root = os.environ.get("HSTACK_DESKTOP_PROJECT_ROOT", "")
    if not root or not Path(root).is_absolute():
        raise HTTPException(status_code=503, detail="Set HSTACK_DESKTOP_PROJECT_ROOT for the Hermes gateway and build Hstack.")
    node = os.environ.get("HSTACK_DESKTOP_NODE") or shutil.which("node")
    if node and not Path(node).is_absolute():
        raise HTTPException(status_code=503, detail="HSTACK_DESKTOP_NODE must be an absolute path.")
    script = Path(root) / "dist" / "desktop-bridge.js"
    if not node or not script.is_file():
        raise HTTPException(status_code=503, detail="Node or the built Hstack bridge is unavailable.")
    # Pass only required process configuration. The key goes through stdin,
    # never argv, environment variables, logs or response payloads.
    child_env = {k: os.environ[k] for k in ("HOME", "PATH", "HSTACK_STATE_DIR", "HSTACK_CREDENTIAL_BACKEND", "HSTACK_MASTER_KEY_FILE") if k in os.environ}
    if state_dir:
        child_env["HSTACK_STATE_DIR"] = state_dir
    try:
        proc = subprocess.run([node, str(script)], input=json.dumps(request), text=True,
                              capture_output=True, timeout=45, env=child_env, check=False)
        result = json.loads(proc.stdout)
        if not isinstance(result, dict) or set(result) != {"state", "message"}:
            raise ValueError("Invalid response")
        if result["state"] not in {"saved", "not_saved", "verified", "discovered", "active", "degraded", "error", "reauth_required", "rate_limited", "migration_required", "vault_unavailable"}:
            raise ValueError("Invalid state")
        if not isinstance(result["message"], str) or len(result["message"]) > 300:
            raise ValueError("Invalid message")
        return result
    except (OSError, subprocess.TimeoutExpired, ValueError, TypeError):
        raise HTTPException(status_code=503, detail="Hstack could not complete the request.") from None

@router.post("/providers/{provider}")
async def provider_action(provider: str, request: Request, profile: Optional[str] = None):
    if provider not in PROVIDERS:
        raise HTTPException(status_code=404, detail="Unsupported provider.")
    # Validate manually: framework validation errors can echo secret input.
    raw = await request.body()
    if len(raw) > 8192:
        raise HTTPException(status_code=400, detail="Invalid request.")
    try:
        body = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(status_code=400, detail="Invalid request.") from None
    if (not isinstance(body, dict) or set(body) - {"action", "key"}
            or not isinstance(body.get("action"), str)
            or ("key" in body and (not isinstance(body["key"], str) or len(body["key"]) > 4096))):
        raise HTTPException(status_code=400, detail="Invalid request.")
    body["provider"] = provider
    return await asyncio.to_thread(scoped_action, body, profile)

@router.post("/buffer")
async def buffer_action(request: Request, profile: Optional[str] = None):
    return await provider_action("buffer", request, profile)


def desktop_config(home: Path):
    root = Path(os.environ.get("HSTACK_DESKTOP_PROJECT_ROOT", ""))
    node = os.environ.get("HSTACK_DESKTOP_NODE") or shutil.which("node")
    if not root.is_absolute() or not node or not Path(node).is_absolute() or not (root / "dist" / "desktop-server.js").is_file():
        raise HTTPException(status_code=503, detail="Build Hstack and configure its absolute project and Node paths.")
    state_dir = str(home / "hstack-connections")
    name = "hstack-desktop-" + hashlib.sha256(str(home).encode()).hexdigest()[:12]
    config = {"command": node, "args": [str(root / "dist" / "desktop-server.js")],
              "env": {"HSTACK_STATE_DIR": state_dir}, "timeout": 120, "connect_timeout": 30}
    for key in ("HSTACK_CREDENTIAL_BACKEND", "HSTACK_MASTER_KEY_FILE"):
        if key in os.environ:
            config["env"][key] = os.environ[key]
    return name, config, state_dir


def use_native(provider: str, name: str, config: dict, home: Path):
    if provider not in {"buffer", "pallyy", "blotato", "ayrshare"}:
        return {"state": "error", "message": "No reviewed read is available for this provider."}
    # A separate native worker owns only this connection, never another profile's
    # running registry. Kill its process group on timeout, including MCP children.
    env = {k: os.environ[k] for k in ("HOME", "PATH") if k in os.environ}
    env.update(HERMES_HOME=str(home), PYTHONDONTWRITEBYTECODE="1", PYTHON_DOTENV_DISABLED="1")
    import hermes_cli
    env["PYTHONPATH"] = str(Path(hermes_cli.__file__).resolve().parent.parent)
    process = subprocess.Popen([sys.executable, str(Path(__file__).with_name("native_probe.py"))],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        env=env, start_new_session=True)
    try:
        out, _ = process.communicate(json.dumps({"provider": provider, "name": name, "config": config}), timeout=120)
        result = json.loads(out)
        if not isinstance(result, dict) or set(result) != {"state", "message"} or result["state"] not in {"used", "error"} or not isinstance(result["message"], str) or len(result["message"]) > 300:
            raise ValueError("Invalid worker result")
        return result
    except (ValueError, subprocess.TimeoutExpired):
        return {"state": "error", "message": "Hermes read did not finish. Check connection access and retry."}
    finally:
        # MCP SDK children may create their own sessions; graceful native shutdown
        # normally closes them. Ensure our worker itself cannot remain behind.
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate()


def scoped_action(body: dict, profile: Optional[str]):
    # Same context-local profile resolution and mutation lock used by Hermes' own
    # MCP routes. Never interpret a UI string as a filesystem path or command.
    from hermes_cli.web_server import _config_profile_scope, _CONFIG_MUTATION_LOCK
    from hermes_constants import get_hermes_home
    from hermes_cli.mcp_config import _get_mcp_servers, _save_mcp_server
    with _config_profile_scope(profile):
        home = get_hermes_home()
        name, config, state_dir = desktop_config(home)
        action = body["action"]
        if action not in {"activate", "use"}:
            return run_bridge(body, state_dir)
        status = run_bridge({"action": "status", "provider": body["provider"]}, state_dir)
        if status["state"] not in {"verified", "active", "degraded"}:
            return {"state": "error", "message": "Save and validate the key before activating or using it."}
        if action == "activate":
            with _CONFIG_MUTATION_LOCK:
                existing = _get_mcp_servers().get(name)
                if existing is not None and existing != config:
                    return {"state": "error", "message": "An existing Hstack Desktop entry has different settings. It was preserved; review it in Hermes MCP settings."}
                if existing is None and not _save_mcp_server(name, config):
                    return {"state": "error", "message": "Hermes rejected the Hstack configuration; no key was activated."}
            result = run_bridge({"action": "activate", "provider": body["provider"]}, state_dir)
            if result["state"] == "active":
                result["message"] = "Activated in this Hermes profile. Use the read button to verify it. Start a new chat if Hstack was just added."
            return result
        if status["state"] not in {"active", "degraded"} or _get_mcp_servers().get(name) != config:
            return {"state": "error", "message": "Activate this key and the Hstack connection before using it."}
        try:
            return use_native(body["provider"], name, config, home)
        except Exception:
            return {"state": "error", "message": "Hermes could not launch its native MCP read check."}
