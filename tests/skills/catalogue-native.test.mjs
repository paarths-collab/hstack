import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkAgainstV0225, hermesInvocations } from './helpers/hermes-calls.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const skills = readdirSync(path.join(root, 'skills'), { withFileTypes: true })
  .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();

// The old check covered only the first migration wave. Check the whole shipped
// catalogue against the actual pinned argparse builders, including future skills.
for (const name of skills) {
  test(`${name}: every extracted Hermes command parses against pinned 0.22.5`, () => {
    const markdown = readFileSync(path.join(root, 'skills', name, 'SKILL.md'), 'utf8');
    const calls = hermesInvocations(markdown);
    const invalid = checkAgainstV0225(calls).filter(call => call.code !== 0);
    assert.deepEqual(invalid.map(call => ({ line: call.line, argv: call.argv, output: call.output })), []);
    assert.ok(!calls.some(call => call.argv.includes('--daemon')), 'the gateway has no --daemon option');
  });
}
