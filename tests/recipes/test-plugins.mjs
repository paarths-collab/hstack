import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const read = name => JSON.parse(readFileSync(path.join(root, name), 'utf8'));
const portable = read('plugin.json');
const hosts = ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', '.cursor-plugin/plugin.json'];
const names = readdirSync(path.join(root, 'skills')).filter(name => !name.startsWith('.') && statSync(path.join(root, 'skills', name)).isDirectory());
const version = /^HERMES_VERSION=(.+)$/m.exec(readFileSync(path.join(root, 'VERSIONS.txt'), 'utf8'))[1];
const inside = relative => {
  assert.ok(relative.startsWith('./'), `relative plugin path required: ${relative}`);
  const target = path.resolve(root, relative);
  assert.ok(target === root || target.startsWith(root + path.sep), `path escapes plugin root: ${relative}`);
  assert.ok(statSync(target).isDirectory());
  return target;
};

test('portable manifest uses the Agent Plugins schema and no legacy top-level component fields', () => {
  assert.equal(portable.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  const allowed = new Set(['$schema','name','version','description','author','homepage','repository','license','keywords','extensions']);
  for (const key of Object.keys(portable)) assert.ok(allowed.has(key), `unsupported portable field ${key}`);
  assert.match(portable.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.match(portable.version, /^\d+\.\d+\.\d+$/);
  assert.equal(portable.license, 'Apache-2.0');
});

for (const manifest of hosts) test(`${manifest}: identity, version and catalogue metadata match portable source`, () => {
  const host = read(manifest);
  for (const key of ['name','version','description','homepage','repository','license','keywords']) assert.deepEqual(host[key], portable[key], `${manifest} ${key}`);
  assert.equal(host.author.name, portable.author.name);
  assert.ok(host.description.includes(`${names.length} SSH-first`));
  assert.ok(host.description.includes(`${names.filter(n => n.startsWith('integration-')).length} integrations`));
  assert.ok(host.description.includes(`${names.filter(n => n.startsWith('platform-')).length} chat platforms`));
  assert.ok(host.description.includes(`Hermes ${version}`));
  assert.match(host.description, /live vendor validation remains pending/);
});

test('Codex presentation matches portable metadata and satisfies current listing limits', () => {
  const ui = portable.extensions['com.openai'].interface;
  assert.deepEqual(read('.codex-plugin/plugin.json').interface, ui);
  assert.ok(ui.shortDescription.trim().length > 0 && [...ui.shortDescription].length <= 30);
  assert.equal(ui.category, 'Developer Tools');
  assert.ok(Array.isArray(ui.defaultPrompt) && ui.defaultPrompt.length > 0 && ui.defaultPrompt.length <= 3);
  assert.equal(new Set(ui.defaultPrompt.map(s => s.trim().replace(/\s+/g,' '))).size, ui.defaultPrompt.length);
  for (const prompt of ui.defaultPrompt) assert.ok(prompt.trim() && prompt.length <= 128 && !/[\r\n]/.test(prompt));
  assert.match(ui.longDescription, /not live vendor or gateway verification/);
  assert.doesNotMatch(ui.longDescription, /Every skill.*live vendor API|rolls back cleanly/i);
  for (const key of ['websiteURL','privacyPolicyURL','termsOfServiceURL']) assert.equal(new URL(ui[key]).protocol, 'https:');
});

test('Claude marketplace resolves the current plugin at the repository root', () => {
  const market = read('.claude-plugin/marketplace.json');
  assert.equal(market.name, 'hstack');
  assert.equal(market.plugins.length, 1);
  const entry = market.plugins[0];
  for (const key of ['name','version','description']) assert.equal(entry[key], portable[key]);
  assert.equal(inside(entry.source), path.resolve(root));
});

test('Codex marketplace exposes an optional local plugin without installing or enabling it', () => {
  const market = read('.agents/plugins/marketplace.json');
  assert.equal(market.name, 'hstack');
  assert.equal(market.plugins.length, 1);
  const entry = market.plugins[0];
  assert.equal(entry.name, portable.name);
  assert.equal(entry.source.source, 'local');
  assert.equal(inside(entry.source.path), path.resolve(root));
  assert.equal(entry.policy.installation, 'AVAILABLE');
  assert.equal(entry.policy.authentication, 'ON_INSTALL');
  assert.equal(entry.category, portable.extensions['com.openai'].interface.category);
});

test('portable/default and explicit host discovery all expose the same valid skill tree', () => {
  for (const name of names) {
    const file = path.join(root, 'skills', name, 'SKILL.md');
    assert.ok(statSync(file).size <= 1024 * 1024);
    const text = readFileSync(file, 'utf8');
    assert.ok(text.startsWith('---\n'));
    const frontmatter = text.split('\n---')[0];
    assert.equal(/^name:\s*(.+)$/m.exec(frontmatter)?.[1].replace(/^["']|["']$/g,''), name);
    assert.match(frontmatter, /^description:\s*\S.+$/m);
  }
  for (const manifest of hosts) {
    const host = read(manifest);
    assert.equal(inside(host.skills ?? './skills/'), path.resolve(root, 'skills'));
  }
});

test('CI reruns plugin regressions when any packaged manifest or marketplace changes', () => {
  const workflow = readFileSync(path.join(root, '.github/workflows/recipe-tests.yml'), 'utf8');
  for (const pattern of ['plugin.json','.agents/plugins/**','.claude-plugin/**','.codex-plugin/**','.cursor-plugin/**']) {
    assert.equal(workflow.split(`      - "${pattern}"`).length - 1, 2, `${pattern} needs push and pull_request coverage`);
  }
});
