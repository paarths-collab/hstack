"""Native Hermes discovery/write-block probe; no real ADC, Google API or model."""
import json
import os
from pathlib import Path
import sys


def run():
    probe = json.loads(Path(sys.argv[1]).read_text())
    sys.path.insert(0, probe["source"])
    from tools import mcp_tool
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from hermes_mcp_compat import resolve_mcp_api
    register_mcp_servers, mcp_prefixed_tool_name, shutdown_mcp_servers = resolve_mcp_api(mcp_tool)
    from tools.registry import registry

    config = json.loads((Path(os.environ["HERMES_HOME"]) / "config.yaml").read_text())
    names = register_mcp_servers(config["mcp_servers"])
    search = mcp_prefixed_tool_name("hstack", "hstack_search_tools")
    call = mcp_prefixed_tool_name("hstack", "hstack_call_tool")
    try:
        assert search in names and call in names
        found = registry.dispatch(search, {"service": "google-analytics", "query": "get_account_summaries", "limit": 1})
        assert "google-analytics__get_account_summaries" in json.dumps(found)
        blocked = registry.dispatch(call, {"name": "google-analytics__create_property_annotation", "arguments": {
            "property_id": "123", "title": "Synthetic blocked annotation", "start_date": "2026-01-01"
        }})
        assert "Write tools are disabled" in json.dumps(blocked)
    finally:
        shutdown_mcp_servers()
    print("PASS: native Hermes registry searched Analytics schemas and blocked an annotation write. No account read or model used.")


if __name__ == "__main__":
    try:
        run()
    except Exception:
        print("FAIL: native Hermes Analytics probe did not pass; raw results hidden.", file=sys.stderr)
        sys.exit(1)
