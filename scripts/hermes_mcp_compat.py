"""Resolve native registry test APIs across Hermes' monolithic/split layouts.

Verification-only: delegates to Hermes implementations without patching core.
"""
from importlib import import_module


def resolve_mcp_api(core, importer=import_module):
    locations = (
        ("register_mcp_servers", "tools.mcp_tool_discovery"),
        ("mcp_prefixed_tool_name", "tools.mcp_tool_schema"),
        ("shutdown_mcp_servers", "tools.mcp_tool_lifecycle"),
    )
    resolved = []
    for name, module in locations:
        value = getattr(core, name, None)
        if value is None:
            value = getattr(importer(module), name)
        if not callable(value):
            raise TypeError("Unsupported Hermes MCP verification interface: " + name)
        resolved.append(value)
    return tuple(resolved)
