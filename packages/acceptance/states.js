// Transaction states and the only legal transitions between them.
// Anything else throws IllegalTransition: there is no generic "success" state, and a
// partially-applied transaction can only end in verified, restored_verified or
// manual_recovery_required.

export const START = "start";

export const STATES = Object.freeze([
  "validated",
  "inspected",
  "change_reviewed",
  "staged",
  "applied_unverified",
  "verified",
  "rollback_required",
  "restored_verified",
  "manual_recovery_required",
]);

const ORDER = Object.freeze([START, ...STATES]);

export const TRANSITIONS = Object.freeze({
  start: Object.freeze(["validated"]),
  validated: Object.freeze(["inspected"]),
  inspected: Object.freeze(["change_reviewed"]),
  change_reviewed: Object.freeze(["staged"]),
  staged: Object.freeze(["applied_unverified"]),
  applied_unverified: Object.freeze(["verified", "rollback_required"]),
  rollback_required: Object.freeze(["restored_verified", "manual_recovery_required"]),
  verified: Object.freeze([]),
  restored_verified: Object.freeze([]),
  manual_recovery_required: Object.freeze([]),
});

// States in which live (non-hstack-owned) state may legitimately have been mutated.
export const MAY_HAVE_APPLIED = Object.freeze([
  "applied_unverified",
  "verified",
  "rollback_required",
  "restored_verified",
  "manual_recovery_required",
]);

export const TERMINAL_STATES = Object.freeze(["verified", "restored_verified", "manual_recovery_required"]);

export class IllegalTransition extends Error {
  constructor(from, to, detail) {
    super(`illegal transition ${from} -> ${to}${detail ? `: ${detail}` : ""}`);
    this.name = "IllegalTransition";
    this.from = from;
    this.to = to;
  }
}

export function isKnownState(state) {
  return STATES.includes(state);
}

export function canTransition(from, to) {
  return Object.hasOwn(TRANSITIONS, from) && TRANSITIONS[from].includes(to);
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new IllegalTransition(from, to);
  }
}

export function stateIndex(state) {
  return ORDER.indexOf(state);
}

/** True when `state` is at or after `minimum` in the nominal ordering (start < ... < manual_recovery_required). */
export function isAtLeast(state, minimum) {
  const a = stateIndex(state);
  const b = stateIndex(minimum);
  return a >= 0 && b >= 0 && a >= b;
}

export function mayHaveApplied(state) {
  return MAY_HAVE_APPLIED.includes(state);
}
