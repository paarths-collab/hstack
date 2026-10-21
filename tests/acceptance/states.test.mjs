import assert from "node:assert/strict";
import test from "node:test";

import {
  IllegalTransition, START, STATES, TERMINAL_STATES, TRANSITIONS, assertTransition, canTransition, isAtLeast, mayHaveApplied,
} from "../../packages/acceptance/states.js";

const EXPECTED_STATES = [
  "validated", "inspected", "change_reviewed", "staged", "applied_unverified",
  "verified", "rollback_required", "restored_verified", "manual_recovery_required",
];

const LEGAL = new Set([
  "start>validated", "validated>inspected", "inspected>change_reviewed", "change_reviewed>staged",
  "staged>applied_unverified", "applied_unverified>verified", "applied_unverified>rollback_required",
  "rollback_required>restored_verified", "rollback_required>manual_recovery_required",
]);

test("the state names are exactly the nine in the spec, in order", () => {
  assert.deepEqual([...STATES], EXPECTED_STATES);
  assert.equal(START, "start");
});

test("every legal transition is accepted and every other pair throws IllegalTransition", () => {
  const sources = [START, ...STATES];
  let illegal = 0;
  for (const from of sources) {
    for (const to of STATES) {
      const key = `${from}>${to}`;
      if (LEGAL.has(key)) {
        assert.equal(canTransition(from, to), true, key);
        assert.doesNotThrow(() => assertTransition(from, to), key);
      } else {
        illegal += 1;
        assert.equal(canTransition(from, to), false, key);
        assert.throws(() => assertTransition(from, to), IllegalTransition, key);
      }
    }
  }
  assert.equal(LEGAL.size, 9);
  assert.equal(illegal, sources.length * STATES.length - 9);
});

test("no state can be skipped on the way to applied_unverified, and nothing returns to an earlier state", () => {
  assert.throws(() => assertTransition("validated", "staged"), IllegalTransition);
  assert.throws(() => assertTransition("inspected", "applied_unverified"), IllegalTransition);
  assert.throws(() => assertTransition("staged", "verified"), IllegalTransition);
  assert.throws(() => assertTransition("applied_unverified", "staged"), IllegalTransition);
  assert.throws(() => assertTransition("rollback_required", "applied_unverified"), IllegalTransition);
  assert.throws(() => assertTransition("verified", "rollback_required"), IllegalTransition, "verified is final");
});

test("terminal states have no outgoing transitions; unknown names are rejected", () => {
  for (const state of TERMINAL_STATES) assert.deepEqual([...TRANSITIONS[state]], [], state);
  assert.deepEqual([...TERMINAL_STATES].sort(), ["manual_recovery_required", "restored_verified", "verified"]);
  assert.equal(canTransition("done", "verified"), false);
  assert.equal(canTransition("validated", "success"), false);
  assert.throws(() => assertTransition("validated", "success"), IllegalTransition);
  const error = (() => { try { assertTransition("staged", "verified"); } catch (e) { return e; } return null; })();
  assert.equal(error.from, "staged");
  assert.equal(error.to, "verified");
});

test("only states from applied_unverified on may have applied changes", () => {
  for (const state of STATES) {
    assert.equal(mayHaveApplied(state), isAtLeast(state, "applied_unverified"), state);
  }
  assert.equal(mayHaveApplied("staged"), false);
  assert.equal(mayHaveApplied("applied_unverified"), true);
  assert.equal(isAtLeast("verified", "staged"), true);
  assert.equal(isAtLeast("inspected", "staged"), false);
  assert.equal(isAtLeast("bogus", "staged"), false);
});
