# Agent Recipes core

This browser-safe module turns a reviewed Recipe selection into the existing
secret-free Hermes blueprint format. It has no networking, credential fields,
or deployment commands.

It is intentionally small for the first vertical slice:

- `getReadiness()` returns a human-readable preview or ready state.
- `compileFounderBrief()` derives an allowlisted Founder Brief blueprint.
- `stringifyBlueprint()` prepares the only downloadable artifact.

The compiler accepts connector metadata and selections, but never accepts a
skill name, credential, command, URL, or permission policy from the user.
The official `blueprint-install` and specialist hstack skills remain responsible
for validation, credential collection, live verification, and scoped rollback.
