import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { compileFounderBrief, RecipeCompilerError } from '../../packages/recipe-core/index.js';

const root = new URL('../../', import.meta.url);
const read = name => readFileSync(new URL(name, root), 'utf8');
const json = name => JSON.parse(read(name));

test('retired report and transaction runtimes are absent while standalone GitHub integration remains', () => {
  for (const path of ['packages/founder-brief/workflow.py', 'packages/acceptance/index.js',
    'acceptance/founder-brief-github-telegram.contract.json']) {
    assert.equal(existsSync(new URL(path, root)), false, path);
  }
  assert.ok(existsSync(new URL('skills/integration-github/SKILL.md', root)));
  for (const path of ['.github/workflows/recipe-tests.yml', '.github/workflows/shellcheck.yml',
    'README.md', 'docs/README.md', 'docs/architecture.md', 'tests/README.md']) {
    assert.doesNotMatch(read(path), /(?:packages|tests)\/(?:founder-brief|acceptance)\//, path);
  }
  const target = json('compatibility/hermes.json');
  assert.equal(target.target.live_verified, false);
  assert.equal(target.target.workflow_packs, undefined);
  assert.equal(target.legacy_fixture, undefined);
});

test('loaded and fallback planners reject the removed GitHub brief selection', () => {
  const recipe = json('recipes/founder-brief/recipe.json');
  const registry = json('recipes/registry.json');
  assert.ok(!registry.connectors.sources.some(c => c.id === 'github'));
  const connectors = Object.values(registry.connectors).flat().map(c =>
    JSON.parse(readFileSync(new URL(c.path, new URL('recipes/', root)), 'utf8')));
  assert.throws(() => compileFounderBrief({recipe, connectors,
    selection: {sourceIds: ['github'], deliveryIds: ['telegram']}}), RecipeCompilerError);
  assert.equal(compileFounderBrief({recipe, connectors,
    selection: {sourceIds: ['notion'], deliveryIds: ['telegram']}}).deployable, true);
  assert.doesNotMatch(read('apps/composer/app.js'), /id:\s*"github"|"integration-github"/);
});

test('every recipe source and destination still resolves in the retained connector registry', () => {
  const registry = json('recipes/registry.json');
  for (const entry of registry.recipes) {
    const recipe = json(`recipes/${entry.path}`);
    for (const [role, key] of [['sources', 'sources'], ['deliveries', 'deliveries']]) {
      const available = new Set(registry.connectors[key].map(c => c.id));
      for (const id of recipe.connector_rules?.[role]?.ids ?? []) {
        assert.ok(available.has(id), `${entry.id}: unresolved ${role} connector ${id}`);
      }
    }
  }
});
