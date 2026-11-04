"""Native Hermes probe against the verifier's new synthetic MySQL database."""
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
        found = registry.dispatch(search, {"service": "mysql", "query": "list_tables", "limit": 1})
        assert "mysql__list_tables" in json.dumps(found)
        read = registry.dispatch(call, {"name": "mysql__list_tables", "arguments": {
            "table_names": probe["table"], "output_format": "detailed"
        }})
        # A random column name absent from the request proves an actual schema read.
        assert probe["column"] in json.dumps(read)
        blocked = registry.dispatch(call, {"name": "mysql__execute_sql", "arguments": {
            "sql": probe["blockedSql"]
        }})
        assert "Write tools are disabled" in json.dumps(blocked)
    finally:
        shutdown_mcp_servers()
    print("PASS: native Hermes registry searched and read MySQL schema; arbitrary SQL blocked. No model used.")


if __name__ == "__main__":
    try:
        run()
    except Exception:
        print("FAIL: native Hermes MySQL probe did not pass; raw results hidden.", file=sys.stderr)
        sys.exit(1)
