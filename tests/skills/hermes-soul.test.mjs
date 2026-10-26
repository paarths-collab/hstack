// hermes-soul: the real SKILL.md blocks run against a simulated VPS. SOUL.md is written over ssh stdin, snapshotted and restored
// byte for byte, verified, and checked with the native one-shot call. No gateway reload and no `hermes setup` (read from
// agent/prompt_builder.py, agent/system_prompt.py, agent/conversation_loop.py and hermes_cli/setup.py at v0.22.5).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { assertStateIdentical, writeEvents } from "./helpers/asserts.mjs";
import { assemble, loadBlocks, mustReplace, skillPath } from "./helpers/blocks.mjs";
import { SCRIPT_END, scenario } from "./helpers/sandbox.mjs";

const SKILL = "hermes-soul";
const PRE = ["before-you-start#1", "step0#1"];
const FLOW = ["step1#1", "step2#1", "step3#1", "step4#1", "step5#1", "step6#1", "step7#1"];
const flow = ({ ids = FLOW, replace = [], pre = "" } = {}) =>
  assemble(["set +e\n", pre, { skill: SKILL, ids: PRE, replace }, { skill: SKILL, ids, replace }, SCRIPT_END]);
const calls = (run) => run.sb.hermesCalls().map((c) => c.join(" "));
const EXPECTED = (name, style) => `# Identity\nYou are ${name}, a personal AI assistant.\n\n# Style\n${style}\n\n# Avoid\nLong preambles, fabricated results, over-apologizing.\n`;
const SEED = { env: "FOO=bar\n", config: "model.default: old/model\n" };
const OLD_SOUL = "# Identity\nYou are Old, hand written by the user.\n";
const snapDir = ".hermes/.hstack-backup/hermes-soul";
const untouched = (run) => {
  assert.equal(run.after.env, run.before.env, ".env changed");
  assert.equal(run.after.envMode, run.before.envMode);
  assert.equal(run.after.config, run.before.config, "config.yaml changed");
};

describe("hermes-soul: write, verify, no reload", { concurrency: 6 }, () => {
  it("writes exactly the generated text over stdin; no gateway call, no `hermes setup`; the new identity is explained as 'new sessions'", async () => {
    await scenario({ name: "soul-good", seed: SEED, files: { "infer.out": "Atlas\n" }, script: flow(), env: { AGENT_NAME: "Atlas", AGENT_STYLE: "Warm and brief." } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.ok(run.completed);
      assert.equal(run.sb.read(".hermes/SOUL.md"), EXPECTED("Atlas", "Warm and brief."));
      untouched(run);
      const c = calls(run);
      assert.ok(!c.some((x) => /^gateway|^setup|^config set|^mcp/.test(x)), `a SOUL.md edit must not reload or reconfigure anything: ${c}`);
      assert.deepEqual(writeEvents(run), []);
      assert.ok(c.some((x) => x.startsWith("-z ")), "native one-shot smoke test");
      assert.ok(!run.sb.log("hermes-profile.log").includes("unbound"));
      assert.match(run.out, /OK: the agent identifies as 'Atlas'/);
      assert.match(run.out, /No gateway reload/);
      assert.ok(run.sb.exists(`${snapDir}.prev/SOUL.md.absent`), "there was no SOUL.md before: the snapshot says so");
      assert.ok(!run.sb.exists(snapDir));
    });
  });

  it("the default style is used when none is given", async () => {
    await scenario({ name: "soul-default", files: { "infer.out": "Juno\n" }, script: flow(), env: { AGENT_NAME: "Juno" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.equal(run.sb.read(".hermes/SOUL.md"), EXPECTED("Juno", "Concise, direct, helpful. No filler, no hedging."));
    });
  });

  it("SOUL_FILE: the user's own file lands byte for byte (UTF-8, quotes, $ and backticks intact)", async () => {
    const mine = "# Voice\nYou are \"Mira\" — $HOME `date` 'quoted' \\ backslash\n\n- terse\n- kind\n";
    await scenario({ name: "soul-file", files: { "mine.md": mine, "infer.out": "Mira\n" }, script: flow({ pre: 'SOUL_FILE="$HOME/mine.md"\n' }), env: { AGENT_NAME: "Mira" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.equal(run.sb.read(".hermes/SOUL.md"), mine);
      assert.ok(!run.sb.exists("pwned"));
    });
  });

  it("the file is written in place: an existing file keeps its mode", async () => {
    await scenario({ name: "soul-mode", seed: { ...SEED, soul: OLD_SOUL }, files: { "infer.out": "Atlas\n" }, setup: (sb) => sb.write(".hermes/SOUL.md", OLD_SOUL, 0o640), script: flow(), env: { AGENT_NAME: "Atlas", FORCE: "1" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.equal(run.sb.mode(".hermes/SOUL.md"), 0o640);
      assert.equal(run.sb.read(`${snapDir}.prev/SOUL.md`), OLD_SOUL, "the previous file is kept as .prev");
    });
  });
});

describe("hermes-soul: idempotency and the overwrite guard", { concurrency: 6 }, () => {
  it("identical content: exit 0, nothing written, no snapshot, no model call", async () => {
    await scenario({ name: "soul-idem", seed: { ...SEED, soul: EXPECTED("Atlas", "Warm.") }, script: flow(), env: { AGENT_NAME: "Atlas", AGENT_STYLE: "Warm." } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /already has exactly this content/);
      assert.ok(!run.completed);
      assertStateIdentical(run);
      assert.ok(!run.sb.exists(".hermes/.hstack-backup"));
      assert.ok(!calls(run).some((c) => c.startsWith("-z")));
    });
  });
  it("a different SOUL.md without FORCE=1: ABORT, the user's file is untouched", async () => {
    await scenario({ name: "soul-guard", seed: { ...SEED, soul: OLD_SOUL }, script: flow(), env: { AGENT_NAME: "Atlas" } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /ABORT: ~\/\.hermes\/SOUL\.md already exists/);
      assert.match(run.out, /FORCE=1/);
      assertStateIdentical(run);
      assert.ok(!run.sb.exists(".hermes/.hstack-backup"));
    });
  });
  it("a leftover snapshot from a crashed run blocks the next run before the write", async () => {
    await scenario({ name: "soul-left", seed: SEED, files: { ".hermes/.hstack-backup/hermes-soul/.complete": "hstack-soul-snapshot-v1\n" }, script: flow(), env: { AGENT_NAME: "Atlas" } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /ABORT: snapshot failed/);
      assert.equal(run.sb.read(".hermes/SOUL.md"), null);
    });
  });
});

describe("hermes-soul: rollback restores the exact previous bytes", { concurrency: 6 }, () => {
  // root ignores file modes, so a mode-0444 file cannot make the write fail when the suite runs as root (e.g. in a container).
  it("a failed write (read-only existing file) restores the original file and its mode", { skip: process.getuid?.() === 0 && "runs as root: file modes are not enforced" }, async () => {
    await scenario({ name: "soul-rb", seed: { ...SEED, soul: OLD_SOUL }, setup: (sb) => sb.write(".hermes/SOUL.md", OLD_SOUL, 0o444), script: flow(), env: { AGENT_NAME: "Atlas", FORCE: "1" } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /FAIL: could not write/);
      assert.match(run.out, /rollback: restored ~\/\.hermes\/SOUL\.md/);
      assert.equal(run.sb.read(".hermes/SOUL.md"), OLD_SOUL);
      assert.equal(run.sb.mode(".hermes/SOUL.md"), 0o444);
      assert.ok(!calls(run).some((c) => c.startsWith("gateway")), "rollback does not reload the gateway either");
    });
  });
  it("a write that is not byte-identical (append instead of overwrite) fails verification and rolls back", async () => {
    const rep = [['cat > "$HOME/.hermes/SOUL.md"', 'cat >> "$HOME/.hermes/SOUL.md"']];
    mustReplace({ skill: SKILL, ids: ["step5#1"], replace: rep });
    await scenario({ name: "soul-append", seed: { ...SEED, soul: OLD_SOUL }, script: flow({ replace: rep }), env: { AGENT_NAME: "Atlas", FORCE: "1" } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /FAIL: SOUL\.md did not write cleanly/);
      assert.equal(run.sb.read(".hermes/SOUL.md"), OLD_SOUL);
    });
  });
  it("with no previous file the rollback removes the new one", async () => {
    const script = assemble(["set +e\n", { skill: SKILL, ids: PRE }, 'soul_snapshot; printf "x" > "$HOME/.hermes/SOUL.md"; soul_rollback; echo "RC=$?"\n', SCRIPT_END]);
    await scenario({ name: "soul-rb-absent", seed: SEED, script }, async (run) => {
      assert.match(run.out, /RC=0/);
      assert.equal(run.sb.read(".hermes/SOUL.md"), null);
      assert.ok(run.sb.exists(`${snapDir}.prev`));
    });
  });
  it("rollback without a snapshot says so and changes nothing", async () => {
    const script = assemble(["set +e\n", { skill: SKILL, ids: PRE }, 'soul_rollback; echo "RC=$?"\n', SCRIPT_END]);
    await scenario({ name: "soul-rb-none", seed: { ...SEED, soul: OLD_SOUL }, script }, async (run) => {
      assert.match(run.out, /no snapshot for hermes-soul/);
      assert.match(run.out, /RC=0/);
      assertStateIdentical(run);
    });
  });
  it("undoing a finished run puts the old file back (the documented .prev recipe, run as written)", async () => {
    const script = assemble(["set +e\n", { skill: SKILL, ids: PRE }, { skill: SKILL, ids: FLOW }, { skill: SKILL, ids: ["rollback#1"] }, SCRIPT_END]);
    await scenario({ name: "soul-undo", seed: { ...SEED, soul: OLD_SOUL }, files: { "infer.out": "Atlas\n" }, script, env: { AGENT_NAME: "Atlas", FORCE: "1" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /rollback: restored ~\/\.hermes\/SOUL\.md/);
      assert.equal(run.sb.read(".hermes/SOUL.md"), OLD_SOUL);
    });
  });
});

describe("hermes-soul: inputs are validated locally before anything is written", { concurrency: 6 }, () => {
  const long = (n) => "a".repeat(n);
  const cases = [
    ["no name", {}, /AGENT_NAME must start with a letter/],
    ["a name starting with a digit", { AGENT_NAME: "9lives" }, /AGENT_NAME must start with a letter/],
    ["a name with a space", { AGENT_NAME: "At las" }, /AGENT_NAME must start with a letter/],
    ["a name with a shell command", { AGENT_NAME: 'Atlas"; touch "$HOME/pwned' }, /AGENT_NAME must start with a letter/],
    ["a name with command substitution", { AGENT_NAME: "Atlas$(touch pwned)" }, /AGENT_NAME must start with a letter/],
    ["a name of 33 characters", { AGENT_NAME: `A${long(32)}` }, /longer than 32/],
    ["a style with a newline", { AGENT_NAME: "Atlas", AGENT_STYLE: "line one\nline two" }, /single line/],
    ["a style of 301 characters", { AGENT_NAME: "Atlas", AGENT_STYLE: long(301) }, /longer than 300/],
  ];
  for (const [label, env, re] of cases) {
    it(`${label}: ABORT, nothing written`, async () => {
      await scenario({ name: "soul-val", seed: { ...SEED, soul: OLD_SOUL }, script: flow(), env }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, re);
        assert.match(run.out, /Nothing was written/);
        assertStateIdentical(run);
        assert.ok(!run.sb.exists("pwned"));
        assert.ok(!run.sb.exists(".hermes/.hstack-backup"));
      });
    });
  }
  for (const [label, files, re] of [
    ["a missing SOUL_FILE", {}, /not a readable file/],
    ["an empty SOUL_FILE", { "mine.md": "" }, /1 to 50000 bytes/],
    ["a SOUL_FILE of 50001 bytes", { "mine.md": "a".repeat(50001) }, /1 to 50000 bytes/],
    ["a binary SOUL_FILE", { "mine.md": "abc\u0000def\n" }, /NUL bytes/],
  ]) {
    it(`${label}: ABORT, nothing written`, async () => {
      await scenario({ name: "soul-val2", seed: SEED, files, script: flow({ pre: 'SOUL_FILE="$HOME/mine.md"\n' }), env: {} }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, re);
        assertStateIdentical(run);
      });
    });
  }
  it("an unreachable SSH host aborts at the first block", async () => {
    await scenario({ name: "soul-ssh", knobs: { ssh_down: true }, script: flow(), env: { AGENT_NAME: "Atlas" } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /ABORT: SSH/);
    });
  });
  it("a Hermes that is not 0.22.5 stops the procedure before any write", async () => {
    await scenario({ name: "soul-ver", files: { "hermes.version": "hermes 0.17.1\n" }, script: flow(), env: { AGENT_NAME: "Atlas" } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /ABORT: .*0\.22\.5/);
      assert.equal(run.sb.read(".hermes/SOUL.md"), null);
    });
  });
});

describe("hermes-soul: the one-shot check is honest", { concurrency: 6 }, () => {
  it("a reply without the name is a WARN, not a success; the file stays and the run finishes", async () => {
    await scenario({ name: "soul-warn", seed: SEED, files: { "infer.out": "Hermes Agent\n" }, script: flow(), env: { AGENT_NAME: "Atlas" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /WARN: the agent answered 'Hermes Agent'/);
      assert.ok(!/OK: the agent identifies/.test(run.out));
      assert.equal(run.sb.read(".hermes/SOUL.md"), EXPECTED("Atlas", "Concise, direct, helpful. No filler, no hedging."));
    });
  });
  it("a failed model call is UNVERIFIED and does NOT roll back a correct file", async () => {
    await scenario({ name: "soul-unver", seed: SEED, knobs: { "fail.infer": true }, script: flow(), env: { AGENT_NAME: "Atlas" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /UNVERIFIED/);
      assert.equal(run.sb.read(".hermes/SOUL.md"), EXPECTED("Atlas", "Concise, direct, helpful. No filler, no hedging."));
      assert.ok(run.sb.exists(`${snapDir}.prev`));
    });
  });
  it("the name check is case-insensitive", async () => {
    await scenario({ name: "soul-case", files: { "infer.out": "I am ATLAS.\n" }, script: flow(), env: { AGENT_NAME: "Atlas" } }, async (run) => {
      assert.match(run.out, /OK: the agent identifies as 'Atlas'/);
    });
  });
  it("with SOUL_FILE and no AGENT_NAME the skill says it cannot check the name", async () => {
    await scenario({ name: "soul-nofile-name", files: { "mine.md": "You are Mira.\n", "infer.out": "Mira\n" }, script: flow({ pre: 'SOUL_FILE="$HOME/mine.md"\n' }), env: {} }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /cannot check the name/);
    });
  });
});

describe("hermes-soul: static facts about the text", () => {
  const text = readFileSync(skillPath(SKILL), "utf8");
  it("only the shared lifecycle helpers mention the gateway; no step calls `hermes setup`", () => {
    for (const b of loadBlocks(SKILL)) {
      if (b.id === "step0#1") continue;
      const code = b.code.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
      assert.doesNotMatch(code, /\bhermes\b[^\n]*\b(gateway|setup)\b|\bgw_(ready|reload)\b/, `${b.id}`);
    }
  });
  it("states the corrected facts about `hermes setup agent` and the reload", () => {
    assert.match(text, /`hermes setup agent` is the "Agent Settings" section/);
    assert.doesNotMatch(text, /hangs forever|hang forever/i);
    assert.match(text, /No gateway reload/);
    assert.match(text, /agent\/conversation_loop\.py:817-897/);
    assert.match(text, /FLOOR of\s+the cap/);
  });
  it("cites its source and says what was not verified", () => {
    assert.match(text, /## Verified against Hermes v0\.22\.5/);
    assert.match(text, /\*\*Not verified:\*\*/);
  });
});
