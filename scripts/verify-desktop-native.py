"""Opt-in Buffer read acceptance through the plugin API and installed Hermes.

Uses a disposable Hermes profile; never installs a plugin in the normal profile,
uses a model, writes to Buffer, or prints credentials/account data. Requires a
pre-existing key file and explicit --live-buffer-read. This is backend acceptance,
NOT a claim that the Hermes Desktop application or renderer was tested.
"""
import argparse
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import subprocess
import selectors
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--hermes-source", type=Path, required=True)
    parser.add_argument("--project", type=Path, required=True)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--buffer-env-file", type=Path, required=True)
    parser.add_argument("--renderer-dependencies", type=Path)
    parser.add_argument("--live-buffer-read", action="store_true", required=True)
    args = parser.parse_args()
    from dotenv import dotenv_values
    key = dotenv_values(args.buffer_env_file).get("BUFFER_API_KEY")
    if not key or not key.strip():
        raise ValueError("No Buffer key configured")
    with tempfile.TemporaryDirectory(prefix="hstack-desktop-native-") as temporary:
        home = Path(temporary)
        os.environ.clear()
        os.environ.update(HOME=str(home), HERMES_HOME=str(home), PATH=f"{args.node.parent}:/usr/bin:/bin",
                          HSTACK_DESKTOP_PROJECT_ROOT=str(args.project.resolve()), HSTACK_DESKTOP_NODE=str(args.node.resolve()),
                          PYTHONDONTWRITEBYTECODE="1", PYTHON_DOTENV_DISABLED="1")
        master = home / "vault.key"
        master.write_bytes(os.urandom(32)); master.chmod(0o600)
        os.environ.update(HSTACK_CREDENTIAL_BACKEND="keyfile", HSTACK_MASTER_KEY_FILE=str(master))
        preserved = {"url": "https://example.invalid/mcp", "enabled": False}
        (home / "config.yaml").write_text(json.dumps({"mcp_servers": {"preserved": preserved}}))
        sys.path.insert(0, str(args.hermes_source.resolve()))
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        path = args.project / "hermes-plugin/hstack-connections/dashboard/plugin_api.py"
        spec = importlib.util.spec_from_file_location("hstack_desktop_acceptance", path)
        plugin = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = plugin
        spec.loader.exec_module(plugin)
        app = FastAPI()
        app.include_router(plugin.router, prefix="/api/plugins/hstack-connections")
        def check_vault(action):
            files = list((home / "hstack-connections").glob("*.json"))
            if action == "disconnect":
                assert not files
            elif action in {"save", "test", "activate", "use", "deactivate"}:
                assert len(files) == 1
                raw = files[0].read_text()
                assert key not in raw and json.loads(raw).get("hstackVault") == 1
        with TestClient(app) as client:
            def action(action, expected, **body):
                result = client.post("/api/plugins/hstack-connections/providers/buffer", json={"action": action, **body})
                if result.status_code != 200 or result.json().get("state") != expected:
                    # Error states are sanitized by the plugin, but do not echo even
                    # those here: public evidence contains only the failed stage.
                    codes = {"Hermes could not launch its native MCP read check.": "launch", "Hermes read did not finish. Check connection access and retry.": "worker-output", "Hermes could not complete the read through Hstack. Check the saved key, activation, network and Hermes version.": "native-read"}
                    raise ValueError(f"Stage failed: {action}; HTTP {result.status_code}; boundary {codes.get(result.json().get('message'), 'other')}")
                if key in result.text:
                    raise ValueError("Secret exposed")
                check_vault(action)
            if args.renderer_dependencies:
                process = subprocess.Popen([str(args.node), str(args.project / "scripts/verify-desktop-renderer.mjs")],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
                try:
                    process.stdin.write(json.dumps({"kind": "initialize", "key": key, "dependencies": str(args.renderer_dependencies.resolve())})+"\n")
                    process.stdin.flush()
                    deadline = time.monotonic()+240
                    selector = selectors.DefaultSelector()
                    selector.register(process.stdout, selectors.EVENT_READ)
                    while True:
                        if not selector.select(max(0, deadline-time.monotonic())):
                            raise ValueError("Stage failed: renderer timeout")
                        line = process.stdout.readline()
                        if not line:
                            raise ValueError("Stage failed: renderer stopped")
                        message = json.loads(line)
                        if message.get("kind") == "complete":
                            if message.get("passed") is not True:
                                raise ValueError("Stage failed: renderer assertion")
                            break
                        if message.get("path") != "/providers/buffer":
                            raise ValueError("Stage failed: unexpected renderer route")
                        response = client.post("/api/plugins/hstack-connections"+message["path"], json=message["options"]["body"])
                        if key in response.text:
                            raise ValueError("Secret exposed")
                        check_vault(message["options"]["body"]["action"])
                        process.stdin.write(json.dumps({"id": message["id"], "result": response.json(), "error": response.status_code != 200})+"\n")
                        process.stdin.flush()
                    selector.close()
                    if process.wait(timeout=10) != 0:
                        raise ValueError("Stage failed: renderer cleanup")
                finally:
                    if process.poll() is None:
                        process.kill();process.wait(timeout=10)
            else:
                action("save", "saved", key=key)
                action("activate", "error")
                action("test", "verified")
                action("activate", "active")
                action("use", "used")
                action("deactivate", "verified")
                action("use", "error")
                action("disconnect", "not_saved")
            import yaml
            config = yaml.safe_load((home / "config.yaml").read_text())
            assert config["mcp_servers"]["preserved"] == preserved
            assert len(config["mcp_servers"]) == 2
            assert key not in json.dumps(config)
    return {"result": "passed", "path": "plugin HTTP -> private Node store -> native Hermes configuration -> native registry -> Hstack stdio -> Buffer account read",
            "profile": "disposable", "credentialStorage": "AES-256-GCM with disposable private master-key file; encrypted envelope checked after every operation", "modelUsed": False, "desktopAppTested": False, "reactRendererTested": bool(args.renderer_dependencies), "vendorWrites": False,
            "checks": ["save", ("prevalidation activation button disabled" if args.renderer_dependencies else "prevalidation activation blocked"), "authenticated validation", "activate", "native registry read", "deactivate", ("inactive read button disabled" if args.renderer_dependencies else "inactive read blocked"), "remove key", "unrelated configuration preserved"]}


if __name__ == "__main__":
    try:
        # Installed Hermes may emit startup logs. Account data is never evidence.
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            result = main()
        print(json.dumps(result))
    except Exception as error:
        message = str(error) if isinstance(error, ValueError) and str(error).startswith("Stage failed:") else "Check failed; raw diagnostics withheld."
        print(json.dumps({"result": "failed", "message": message}))
        sys.exit(1)
