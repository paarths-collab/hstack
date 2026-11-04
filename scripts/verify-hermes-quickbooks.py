"""Native Hermes registry against synthetic Intuit OAuth/API; no account or model."""
import json
import os
from pathlib import Path
import sys


def run():
    probe = json.loads(Path(sys.argv[1]).read_text())
    # This registry probe needs only local stdio. Refuse Python-side egress too.
    def guard(event, args):
        if event == "socket.connect":
            raise RuntimeError("Network is not allowed in the native registry probe")
    sys.addaudithook(guard)
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
        found = registry.dispatch(search, {"service": "quickbooks", "query": "get_company_info", "limit": 1})
        assert "quickbooks__get_company_info" in json.dumps(found)
        result = registry.dispatch(call, {"name": "quickbooks__get_company_info", "arguments": {"params": {}}})
        assert probe["companyName"] in json.dumps(result)
        blocked = registry.dispatch(call, {"name": "quickbooks__get_invoice_pdf", "arguments": {"params": {}}})
        assert "Write tools are disabled" in json.dumps(blocked)
    finally:
        shutdown_mcp_servers()
    print("PASS: native Hermes registry read the synthetic company and blocked PDF download. No account or model used.")


if __name__ == "__main__":
    try:
        run()
    except Exception:
        print("FAIL: native Hermes QuickBooks fixture probe failed; raw results hidden.", file=sys.stderr)
        sys.exit(1)
