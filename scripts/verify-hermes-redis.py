"""Opt-in native Hermes registry probe against the disposable Redis verifier.

No LLM, hosted credentials, normal Hermes configuration or external writes.
Installed Hermes source/API compatibility is checked by the actual invocation.
"""
import json
import os
from pathlib import Path
import sys


def run():
    probe = json.loads(Path(sys.argv[1]).read_text())
    source = Path(probe["source"])
    sys.path.insert(0, str(source))
    from tools import mcp_tool
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from hermes_mcp_compat import resolve_mcp_api
    register_mcp_servers, mcp_prefixed_tool_name, shutdown_mcp_servers = resolve_mcp_api(mcp_tool)
    from tools.registry import registry

    config = json.loads((Path(os.environ["HERMES_HOME"]) / "config.yaml").read_text())
    names = register_mcp_servers(config["mcp_servers"])
    call_name = mcp_prefixed_tool_name("hstack", "hstack_call_tool")
    search_name = mcp_prefixed_tool_name("hstack", "hstack_search_tools")
    try:
        assert call_name in names and search_name in names
        found = registry.dispatch(search_name, {"query": "redis__get", "service": "redis", "limit": 10})
        assert "redis__get" in json.dumps(found)
        read = registry.dispatch(call_name, {"name": "redis__get", "arguments": {"key": probe["key"]}})
        assert probe["value"] in json.dumps(read)
        blocked = registry.dispatch(call_name, {"name": "redis__set", "arguments": {
            "key": probe["blockedKey"], "value": "must not be stored", "expiration": 120
        }})
        assert "Write tools are disabled" in json.dumps(blocked)
    finally:
        shutdown_mcp_servers()
    print("PASS: native Hermes registry searched and read Redis through Hstack; write was blocked. No model used.")


if __name__ == "__main__":
    try:
        run()
    except Exception:
        print("FAIL: native Hermes Redis probe did not pass; raw results are hidden.", file=sys.stderr)
        sys.exit(1)
