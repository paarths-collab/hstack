// Static checks for packages/hstack-marketing, mirroring the Hermes portable
// package loader (hermes_cli/agent_plugins.py) and catalog pinning rules.
// No network, no Hermes install, no credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

const root = 'packages/hstack-marketing';
const json = file => JSON.parse(readFileSync(join(root, file), 'utf8'));
const plugin = json('plugin.json');
const mcp = json('mcp.json');

test('plugin.json matches the Agent Plugins v1 subset Hermes accepts', () => {
  const allowed = new Set(['$schema', 'name', 'version', 'description', 'author', 'homepage',
    'repository', 'license', 'keywords', 'extensions']);
  assert.deepEqual(Object.keys(plugin).filter(k => !allowed.has(k)), []);
  assert.equal(plugin.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.match(plugin.name, /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
  assert.ok(plugin.name.length <= 64);
  assert.ok(Object.keys(plugin.author).every(k => ['name', 'email', 'url'].includes(k)));
  assert.ok(plugin.keywords.every(k => typeof k === 'string'));
});

test('every MCP server is gated by Hermes approvals', () => {
  const servers = plugin.extensions['com.nousresearch.hermes'].servers;
  assert.deepEqual(Object.keys(servers).sort(), Object.keys(mcp.mcpServers).sort());
  for (const declaration of Object.values(servers)) assert.equal(declaration.trust, 'untrusted');
});

test('mcp.json has only supported transports and fields', () => {
  assert.deepEqual(Object.keys(mcp).sort(), ['$schema', 'mcpServers']);
  assert.equal(mcp.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
  for (const [name, server] of Object.entries(mcp.mcpServers)) {
    if (server.type === 'streamable-http') {
      assert.deepEqual(Object.keys(server).filter(k => !['type', 'url', 'headers'].includes(k)), [], name);
      const url = new URL(server.url);
      assert.equal(url.protocol, 'https:', name);
      assert.equal(url.username + url.password + url.hash, '', name);
    } else {
      assert.equal(server.type, 'stdio', name);
      assert.deepEqual(Object.keys(server).filter(k => !['type', 'command', 'args', 'env', 'cwd'].includes(k)), [], name);
      assert.match(server.command, /^[A-Za-z0-9._-]+$/, `${name}: bare executable token`);
      assert.ok(server.args.every(a => typeof a === 'string'));
      assert.ok(Object.values(server.env ?? {}).every(v => typeof v === 'string'));
    }
  }
});

test('credentials are only ${VAR} references resolved by Hermes', () => {
  const buffer = mcp.mcpServers.buffer;
  assert.equal(buffer.url, 'https://mcp.buffer.com/mcp');
  assert.equal(buffer.headers.Authorization, 'Bearer ${BUFFER_API_KEY}');
  const mailchimp = mcp.mcpServers.mailchimp;
  assert.equal(mailchimp.env.MAILCHIMP_API_KEY, '${MAILCHIMP_API_KEY}');
  // Any other value that looks like a key or token would be a leaked secret.
  const text = readFileSync(join(root, 'mcp.json'), 'utf8');
  assert.doesNotMatch(text, /[0-9a-f]{32}-us\d+/i);
  assert.doesNotMatch(text, /Bearer (?!\$\{)/);
});

test('Mailchimp runs read-only, without vendor retries, at exact pinned versions', () => {
  const { command, args, env } = mcp.mcpServers.mailchimp;
  assert.equal(command, 'uvx');
  assert.equal(env.MAILCHIMP_READ_ONLY, 'true');
  assert.equal(env.MAILCHIMP_MAX_RETRIES, '0');
  assert.ok(args.includes('mailchimp-mcp==1.2.0'));
  // 1.2.0 imports mcp.server.fastmcp, which MCP SDK 2 removed.
  assert.ok(args.includes('mcp==1.30.0'));
  const pins = readFileSync('integrations/mailchimp/requirements.in', 'utf8');
  assert.match(pins, /^mailchimp-mcp==1\.2\.0$/m);
  assert.match(pins, /^mcp==1\.30\.0$/m);
});

function frontmatter(path) {
  const text = readFileSync(path, 'utf8');
  const match = /^---\n([\s\S]*?)\n---\s*\n/.exec(text);
  assert.ok(match, `${path}: frontmatter`);
  const top = {};
  for (const line of match[1].split('\n')) {
    const m = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (m) top[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return { top, raw: match[1] };
}

test('skills satisfy Agent Skills frontmatter rules', () => {
  const dirs = readdirSync(join(root, 'skills')).filter(d => statSync(join(root, 'skills', d)).isDirectory());
  assert.deepEqual(dirs.sort(), ['marketing-connect', 'marketing-weekly-review',
    'newsletter-from-top-posts', 'social-post-drafts']);
  for (const dir of dirs) {
    const { top, raw } = frontmatter(join(root, 'skills', dir, 'SKILL.md'));
    assert.equal(top.name, dir);
    assert.match(dir, /^(?!.*--)[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(top.description && top.description.length <= 1024, `${dir}: description`);
    // metadata must map string keys to string values.
    const metadata = /\nmetadata:\n((?: {2}.*\n?)*)/.exec(`\n${raw}\n`)?.[1] ?? '';
    for (const line of metadata.split('\n').filter(Boolean)) assert.match(line, /^ {2}[a-z_]+: ".*"$/, `${dir}: ${line}`);
  }
});

test('package ships only readable source files, no links or binaries', () => {
  const walk = dir => readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    const info = lstatSync(path);
    assert.ok(!info.isSymbolicLink(), `${path} is a symlink`);
    return info.isDirectory() ? walk(path) : [path];
  });
  for (const file of walk(root)) {
    assert.match(file, /(\.md|\.json|LICENSE)$/, file);
    assert.ok(!readFileSync(file).includes(0), `${file} contains binary data`);
  }
});
