"""One explicit read through Hermes' native MCP registry; no model or writes.

Runs in its own bounded process so no unrelated running MCP sessions are touched.
The parent supplies a server configuration it constructed, never a UI command.
"""
import contextlib
import io
import importlib
import json
import sys

READS = {"buffer": "get_account", "pallyy": "get_me", "blotato": "blotato_get_user", "ayrshare": "list_profiles"}


def resolve(core, name, module):
    return getattr(core, name, None) or getattr(importlib.import_module(module), name)


def probe(request):
    from tools import mcp_tool
    from tools.registry import registry
    register = resolve(mcp_tool, "register_mcp_servers", "tools.mcp_tool_discovery")
    prefixed = resolve(mcp_tool, "mcp_prefixed_tool_name", "tools.mcp_tool_schema")
    shutdown = resolve(mcp_tool, "shutdown_mcp_servers", "tools.mcp_tool_lifecycle")
    provider = request["provider"]
    tool = READS[provider]
    name = request["name"]
    try:
        names = register({name: request["config"]})
        call = prefixed(name, "hstack_call_tool")
        if call not in names:
            raise ValueError("Connection unavailable")
        result = registry.dispatch(call, {"name": f"{provider}__{tool}", "arguments": {}})
        result = json.loads(result) if isinstance(result, str) else result
        if not isinstance(result, dict) or "error" in result or "result" not in result:
            raise ValueError("Read failed")
        payload = result["result"]
        if provider == "buffer":
            if isinstance(payload, str):
                # Hermes renders multiple MCP text blocks separated by newlines.
                # Buffer can return account JSON followed by quota JSON. Decode
                # the first JSON value, then validate the account shape.
                payload, _ = json.JSONDecoder().raw_decode(payload.lstrip())
            if not isinstance(payload, dict) or not isinstance(payload.get("id"), str) or not payload["id"] or not isinstance(payload.get("organizations"), list):
                raise ValueError("Account response missing")
        elif payload is None or payload == "":
            raise ValueError("Empty result")
        return {"state": "used", "message": f"Hermes' native MCP registry executed {provider}__{tool} through Hstack successfully. No post was published."}
    finally:
        shutdown()


if __name__ == "__main__":
    try:
        data = sys.stdin.buffer.read(16385)
        if len(data) > 16384:
            raise ValueError("Request too large")
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            result = probe(json.loads(data))
    except Exception:
        result = {"state": "error", "message": "Hermes could not complete the read through Hstack. Check the saved key, activation, network and Hermes version."}
    print(json.dumps(result))
