import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scripts = fileURLToPath(new URL('../scripts', import.meta.url));
test('native Hermes verifier supports old and split APIs without hiding import failures or patching core', () => {
  const home = mkdtempSync(join(tmpdir(), 'hstack-hermes-compat-'));
  try {
    execFileSync('python3', ['-I', '-B', '-c', `
import sys
from types import SimpleNamespace
sys.path.insert(0, sys.argv[1])
from hermes_mcp_compat import resolve_mcp_api
register = lambda value: ['registered', value]
name = lambda server, tool: server + '__' + tool
close = lambda: 'closed'
old = SimpleNamespace(register_mcp_servers=register, mcp_prefixed_tool_name=name, shutdown_mcp_servers=close)
def forbidden(module): raise AssertionError('Old layout must not import split modules')
a, b, c = resolve_mcp_api(old, forbidden)
assert a({'hstack': {}}) == ['registered', {'hstack': {}}]
assert b('hstack', 'read') == 'hstack__read' and c() == 'closed'
modules = {
 'tools.mcp_tool_discovery': SimpleNamespace(register_mcp_servers=register),
 'tools.mcp_tool_schema': SimpleNamespace(mcp_prefixed_tool_name=name),
 'tools.mcp_tool_lifecycle': SimpleNamespace(shutdown_mcp_servers=close),
}
core = SimpleNamespace()
a, b, c = resolve_mcp_api(core, modules.__getitem__)
assert (a, b, c) == (register, name, close)
assert vars(core) == {}  # no runtime patch or fake upstream implementation
# An installed split module with a missing dependency is a real error, never an old-layout fallback.
def broken(module): raise ModuleNotFoundError('synthetic internal dependency')
try: resolve_mcp_api(core, broken)
except ModuleNotFoundError: pass
else: raise AssertionError('Dependency failure hidden')
try: resolve_mcp_api(SimpleNamespace(register_mcp_servers=False), modules.__getitem__)
except TypeError: pass
else: raise AssertionError('Invalid interface accepted')
` , scripts], { env: { HOME: home, PATH: process.env.PATH, PYTHON_DOTENV_DISABLED: '1' }, stdio: 'pipe' });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
