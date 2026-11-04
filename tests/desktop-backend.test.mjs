import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('Desktop native-result parsing, profile-scoped activation, collision and API privacy contracts', () => {
  const result = spawnSync('python3', ['-B', 'tests/desktop_backend.py'], {
    encoding: 'utf8', timeout: 30_000,
    env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1', PYTHON_DOTENV_DISABLED: '1' },
  });
  assert.equal(result.status, 0, result.stderr || 'Python contract tests did not finish');
});
