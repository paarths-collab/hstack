"""Native Hermes registry against synthetic Zendesk HTTP only; no real account/model."""
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
        found = registry.dispatch(search, {"service": "zendesk", "query": "zendesk_get_groups", "limit": 1})
        assert "zendesk__zendesk_get_groups" in json.dumps(found)
        result = registry.dispatch(call, {"name": "zendesk__zendesk_get_groups", "arguments": {}})
        assert probe["groupName"] in json.dumps(result)
        blocked = registry.dispatch(call, {"name": "zendesk__zendesk_download_attachment", "arguments": {}})
        assert "Write tools are disabled" in json.dumps(blocked)
    finally:
        shutdown_mcp_servers()
    print("PASS: native Hermes registry read the synthetic Zendesk group and blocked attachment download. No real account or model used.")


if __name__ == "__main__":
    try:
        run()
    except Exception:
        print("FAIL: native Hermes Zendesk fixture probe did not pass; raw results hidden.", file=sys.stderr)
        sys.exit(1)
