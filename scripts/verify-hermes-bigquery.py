"""Installed Hermes registry, synthetic Google transport and Hstack stdio only.

No normal Hermes home/config, model, account, credentials or network are used.
"""
import json
import os
from pathlib import Path
import sys
import importlib.metadata


def run():
    probe = json.loads(Path(sys.argv[1]).read_text())
    def guard(event, args):
        if event == "socket.connect":
            raise RuntimeError("Network is forbidden in the native registry probe")
    sys.addaudithook(guard)
    sys.path.insert(0, probe["source"])
    from tools import mcp_tool
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from hermes_mcp_compat import resolve_mcp_api
    register_mcp_servers, mcp_prefixed_tool_name, shutdown_mcp_servers = resolve_mcp_api(mcp_tool)
    from tools.registry import registry
    assert mcp_tool._ensure_mcp_sdk()
    httpx = mcp_tool.sdk_httpx()
    import httpx as host_httpx
    original_clients = {module: module.AsyncClient for module in (httpx, host_httpx)}
    direct_methods = []
    direct_preflights = []

    def google_fixture(request, response_module=httpx):
        assert str(request.url) == "https://bigquery.googleapis.com/mcp"
        if request.method == "HEAD":
            direct_preflights.append("HEAD")
            return response_module.Response(200, headers={"content-type": "application/json"})
        if request.method in ("GET", "DELETE"):
            return response_module.Response(405)
        assert request.method == "POST"
        body = json.loads(request.content)
        method = body["method"]
        direct_methods.append(method)
        if method == "initialize":
            result = {"protocolVersion": body["params"]["protocolVersion"], "capabilities": {"tools": {}},
                      "serverInfo": {"name": "synthetic-bigquery", "version": "0"}}
        elif method == "notifications/initialized":
            return response_module.Response(204)
        elif method == "tools/list":
            result = {"tools": probe["tools"]}
        elif method == "tools/call":
            assert body["params"]["name"] == "list_dataset_ids"
            assert body["params"]["arguments"]["projectId"] == "fixture-project"
            value = {"datasets": [{"id": probe["datasetId"]}]}
            result = {"content": [{"type": "text", "text": json.dumps(value)}], "structuredContent": value}
        else:
            raise RuntimeError("Unreviewed direct MCP method")
        return response_module.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "result": result})

    def locked_client(module, original):
        class LockedClient(original):
            def __init__(self, *args, **kwargs):
                kwargs["transport"] = module.MockTransport(lambda request: google_fixture(request, module))
                # Proxy mounts override transport=; every fixture route stays local.
                kwargs["mounts"] = {}
                super().__init__(*args, **kwargs)
        return LockedClient

    # SDK 2 uses httpx2, while Hermes' preflight uses host httpx. Keep each
    # response in its own library, and contain both without weakening egress denial.
    for module, original in original_clients.items():
        module.AsyncClient = locked_client(module, original)
    try:
        direct_names = register_mcp_servers({"bigquery_direct": {
            "url": "https://bigquery.googleapis.com/mcp", "protocol": "auto",
            "headers": {"Authorization": "Bearer synthetic-access-value"},
            "sampling": {"enabled": False}, "timeout": 10, "connect_timeout": 10,
        }})
        direct_tool = mcp_prefixed_tool_name("bigquery_direct", "list_dataset_ids")
        assert direct_tool in direct_names
        for _ in range(2):
            direct = registry.dispatch(direct_tool, {"projectId": "fixture-project"})
            assert probe["datasetId"] in json.dumps(direct)

        config = json.loads((Path(os.environ["HERMES_HOME"]) / "config.yaml").read_text())
        names = register_mcp_servers(config["mcp_servers"])
        search = mcp_prefixed_tool_name("hstack", "hstack_search_tools")
        call = mcp_prefixed_tool_name("hstack", "hstack_call_tool")
        assert search in names and call in names
        found = registry.dispatch(search, {"service": "bigquery", "query": "list_dataset_ids", "limit": 1})
        assert "bigquery__list_dataset_ids" in json.dumps(found)
        for _ in range(2):
            result = registry.dispatch(call, {"name": "bigquery__list_dataset_ids", "arguments": {"projectId": "fixture-project"}})
            assert probe["datasetId"] in json.dumps(result)
        blocked = registry.dispatch(call, {"name": "bigquery__execute_sql_readonly", "arguments": {
            "projectId": "fixture-project", "query": "synthetic SQL must never execute"}})
        assert "Write tools are disabled" in json.dumps(blocked)
        assert direct_methods.count("tools/call") == 2
        print("HSTACK_BIGQUERY_NATIVE=" + json.dumps({
            "directHermesLegacyRead": True, "gatewayHermesSearchReadAndSqlBlock": True,
            "directProtocolMode": "auto",
            "directMethods": direct_methods, "directPreflights": direct_preflights, "python": sys.version.split()[0],
            "mcp": importlib.metadata.version("mcp"),
        }))
    finally:
        shutdown_mcp_servers()
        for module, original in original_clients.items():
            module.AsyncClient = original


if __name__ == "__main__":
    try:
        run()
    except Exception:
        print("Native Hermes BigQuery fixture check failed; raw results hidden.", file=sys.stderr)
        sys.exit(1)
