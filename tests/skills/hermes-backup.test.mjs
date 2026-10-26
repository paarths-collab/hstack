// hermes-backup: the real SKILL.md blocks run against a simulated VPS whose `hermes backup` / `hermes import` stubs are
// built from hermes_cli/backup.py at v0.22.5 (tests/skills/stub-commands/{backup,import}.sh). The skill must use the native
// commands (SQLite-safe zip, native `-k` retention, `import --force`), keep the archive private (umask 077, dir 700), verify
// it, and never restore without an explicit gate plus a safety backup. Behaviour of the stubs is an assumption written from the
// source; the argparse that checks every call is the real one.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { assertSecretsNotPrinted, assertStateChanged, assertStateIdentical, idx } from "./helpers/asserts.mjs";
import { assemble, mustReplace, skillPath } from "./helpers/blocks.mjs";
import { SCRIPT_END, scenario } from "./helpers/sandbox.mjs";

const SKILL = "hermes-backup";
const PRE = ["before-you-start#1", "step0#1", "step0b#1"];
const TAKE = ["step1#1", "step2#1", "step3#1", "step4#1", "step5#1", "step6#1"];
const RESTORE = ["restore-1#1", "restore-2#1", "restore-3#1", "restore-4#1", "restore-5#1", "restore-6#1"];

const script = (ids, { replace = [], pre = "" } = {}) =>
  assemble(["set +e\n", pre, { skill: SKILL, ids: PRE, replace }, { skill: SKILL, ids, replace }, SCRIPT_END]);
const backupFlow = (opts) => script(TAKE, opts);
const SECRET = "sk-or-v1-THIS-SECRET-MUST-NEVER-BE-PRINTED-0123456789";
const SEED = { env: `FOO=bar\nOPENROUTER_API_KEY=${SECRET}\n`, config: "model.default: old/model\n" };

const calls = (run) => run.sb.hermesCalls().map((c) => c.join(" "));
const zipNames = (file) => {
  const r = spawnSync("python3", ["-I", "-c", "import sys,zipfile;print('\\n'.join(zipfile.ZipFile(sys.argv[1]).namelist()))", file], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split("\n").filter(Boolean);
};
const zipRead = (file, name) => {
  const r = spawnSync("python3", ["-I", "-c", "import sys,zipfile;sys.stdout.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]).decode())", file, name], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
const archives = (run, dir = "hermes-backups") => run.sb.ls(dir).filter((n) => /^hermes-backup-.*\.zip$/.test(n));
const noRemoteWrites = (run) => assert.ok(!calls(run).some((c) => /^(backup|import|gateway)/.test(c)), `no backup/import/gateway call expected: ${calls(run)}`);

describe("hermes-backup: full backup with the native command", { concurrency: 6 }, () => {
  it("runs `hermes -p default backup -o DIR -k N`, keeps the archive private, verifies it and never touches the gateway or ~/.hermes", async () => {
    await scenario({ name: "bk-good", seed: SEED, script: backupFlow() }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.ok(run.completed);
      const list = archives(run);
      assert.equal(list.length, 1, `one archive, got ${list}`);
      const dir = run.sb.p("hermes-backups");
      assert.deepEqual(calls(run).filter((c) => c.startsWith("backup")), [`backup -o ${dir} -k 7`]);
      assert.ok(!run.sb.log("hermes-profile.log").includes("unbound"), "every hermes call binds -p default");
      assert.equal(run.sb.mode("hermes-backups"), 0o700);
      assert.equal(run.sb.log("backup-birth-mode.log").trim(), "600", "the archive must be private from its first byte (umask 077), not only after check_archive chmods it");
      assert.equal(run.sb.mode(`hermes-backups/${list[0]}`), 0o600);
      const names = zipNames(run.sb.p(`hermes-backups/${list[0]}`));
      assert.ok(names.includes(".env") && names.includes("config.yaml"));
      assert.equal(zipRead(run.sb.p(`hermes-backups/${list[0]}`), "config.yaml"), SEED.config);
      assert.match(run.out, new RegExp(`Archive: .*${list[0]}`));
      assert.match(run.out, /OK: backup complete/);
      assert.match(run.out, /contains your secrets/i);
      assertStateIdentical(run, "a backup is read-only for .env/config.yaml");
      assert.ok(!calls(run).some((c) => c.startsWith("gateway")), "backup is read-only: no gateway call");
      assertSecretsNotPrinted(run, [SECRET]);
      assert.ok(run.sb.sshCalls().every((c) => !c.includes(SECRET)));
    });
  });

  it("native retention: -k N prunes only hermes-backup-*.zip; a hand-named archive survives; KEEP=0 keeps everything", async () => {
    const rounds = (k) =>
      assemble([
        "set +e\n",
        `export KEEP=${k} FORCE=1\n`,
        { skill: SKILL, ids: PRE },
        { skill: SKILL, ids: ["step1#1", "step2#1"] },
        'mkdir -p "$HOME/hermes-backups" && : > "$HOME/hermes-backups/manual-keep.zip"\n',
        { skill: SKILL, ids: ["step5#1"] },
        { skill: SKILL, ids: ["step5#1"] },
        { skill: SKILL, ids: ["step5#1"] },
        SCRIPT_END,
      ]);
    await scenario({ name: "bk-keep2", seed: SEED, script: rounds(2) }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.equal(archives(run).length, 2, "newest 2 kept");
      assert.ok(run.sb.exists("hermes-backups/manual-keep.zip"), "native prune never touches other names");
      assert.ok(calls(run).filter((c) => c.startsWith("backup")).every((c) => c.endsWith("-k 2")));
      assert.match(run.out, /Pruned 1 older hermes-backup-\*\.zip \(keeping 2\)/);
    });
    await scenario({ name: "bk-keep0", seed: SEED, script: rounds(0) }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.equal(archives(run).length, 3, "KEEP=0 keeps everything");
    });
  });

  it("a backup from today exists: exits 0 without a native call; FORCE=1 takes another", async () => {
    const twice = (env) =>
      assemble(["set +e\n", { skill: SKILL, ids: PRE }, { skill: SKILL, ids: TAKE }, `${env}\n`, { skill: SKILL, ids: ["step3#1"] }, 'echo "AFTER-SECOND-CHECK"\n', SCRIPT_END]);
    await scenario({ name: "bk-idem", seed: SEED, script: twice("") }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /already exists/i);
      assert.equal(archives(run).length, 1);
    });
    const forced = assemble(["set +e\n", { skill: SKILL, ids: PRE }, { skill: SKILL, ids: TAKE }, { skill: SKILL, ids: ["step3#1", "step5#1"] }, SCRIPT_END]);
    await scenario({ name: "bk-idem-force", seed: SEED, script: forced, env: { FORCE: "1" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.equal(archives(run).length, 2);
    });
  });

  it("the archive is verified: a corrupt zip fails the run (no OK line)", async () => {
    await scenario({ name: "bk-corrupt", seed: SEED, knobs: { backup_corrupt: true }, script: backupFlow() }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /FAIL: .*integrity/i);
      assert.ok(!/OK: backup complete/.test(run.out));
    });
  });

  it("an archive without any Hermes state file is rejected", async () => {
    const strip = assemble([
      "set +e\n", { skill: SKILL, ids: PRE }, { skill: SKILL, ids: TAKE.slice(0, 5) },
      'python3 -I -c \'import sys,zipfile;zipfile.ZipFile(sys.argv[1],"w").writestr("notes.txt","x")\' "$ARCHIVE"\n',
      { skill: SKILL, ids: ["step6#1"] }, SCRIPT_END,
    ]);
    await scenario({ name: "bk-nomarker", seed: SEED, script: strip }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /does not look like a Hermes backup/);
    });
  });
});

describe("hermes-backup: native exit codes are honoured", { concurrency: 6 }, () => {
  it("exit 1 (incomplete archive kept): FAIL, the path is reported, nothing else runs", async () => {
    await scenario({ name: "bk-incomplete", seed: SEED, knobs: { backup_incomplete: true }, script: backupFlow() }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /FAIL: .*incomplete/i);
      assert.match(run.out, /hermes-backup-.*\.zip/);
      assert.ok(!/OK: backup complete/.test(run.out));
    });
  });
  it("exit 2 (another backup holds the lock): FAIL with the retry hint, no archive", async () => {
    await scenario({ name: "bk-locked", seed: SEED, knobs: { backup_locked: true }, script: backupFlow() }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /another Hermes backup/i);
      assert.equal(archives(run).length, 0);
    });
  });
  it("a hard failure of the native command is reported, never papered over by a hand-rolled tar", async () => {
    await scenario({ name: "bk-fail", seed: SEED, knobs: { "fail.backup": true }, script: backupFlow() }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /FAIL: hermes backup/);
      assert.equal(run.sb.ls("hermes-backups").length, 0);
    });
  });
});

describe("hermes-backup: quick state snapshot", { concurrency: 6 }, () => {
  it("--quick --label: snapshot id parsed, no zip, restore is documented as the /snapshot slash command", async () => {
    await scenario({ name: "bk-quick", seed: SEED, script: backupFlow(), env: { BACKUP_MODE: "quick", LABEL: "pre-model-change" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.deepEqual(calls(run).filter((c) => c.startsWith("backup")), ["backup --quick --label pre-model-change"]);
      assert.equal(archives(run).length, 0);
      const snaps = run.sb.ls(".hermes/state-snapshots");
      assert.equal(snaps.length, 1);
      assert.match(snaps[0], /-pre-model-change$/);
      assert.equal(run.sb.mode(`.hermes/state-snapshots/${snaps[0]}`), 0o700);
      assert.match(run.out, /OK: state snapshot/);
      assert.match(run.out, /\/snapshot restore /);
      assertStateIdentical(run);
      assertSecretsNotPrinted(run, [SECRET]);
    });
  });
});

describe("hermes-backup: inputs are validated locally before anything is written", { concurrency: 6 }, () => {
  const cases = [
    ["unknown BACKUP_MODE", { BACKUP_MODE: "tar" }, /BACKUP_MODE/],
    ["negative KEEP (the native flag would slice away the NEWEST archives)", { KEEP: "-1" }, /KEEP/],
    ["non-numeric KEEP", { KEEP: "many" }, /KEEP/],
    ["LABEL with a quote", { BACKUP_MODE: "quick", LABEL: "a'b" }, /LABEL/],
    ["LABEL with a space", { BACKUP_MODE: "quick", LABEL: "a b" }, /LABEL/],
    ["relative BACKUP_DIR", { BACKUP_DIR: "backups" }, /absolute/],
    ["BACKUP_DIR with ..", { BACKUP_DIR: "/var/../etc/b" }, /BACKUP_DIR/],
    ["BACKUP_DIR with a quote", { BACKUP_DIR: "/var/b'x" }, /BACKUP_DIR/],
    ["BACKUP_DIR with command substitution", { BACKUP_DIR: "/var/$(touch pwned)" }, /BACKUP_DIR/],
  ];
  for (const [label, env, re] of cases) {
    it(`${label}: ABORT, no native call, ~/.hermes untouched`, async () => {
      await scenario({ name: "bk-val", seed: SEED, script: backupFlow(), env }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, /ABORT/);
        assert.match(run.out, re);
        assert.match(run.out, /Nothing was written/);
        noRemoteWrites(run);
        assertStateIdentical(run);
        assert.ok(!run.sb.exists("pwned"));
      });
    });
  }
  it("BACKUP_DIR inside ~/.hermes is refused (it would be archived into the next backup); ~/.hermes/backups is the native exception", async () => {
    await scenario({ name: "bk-inside", seed: SEED, script: `BACKUP_DIR="$HOME/.hermes/more"\n${backupFlow()}` }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /inside ~\/\.hermes/);
      noRemoteWrites(run);
    });
    await scenario({ name: "bk-native-dir", seed: SEED, script: `BACKUP_DIR="$HOME/.hermes/backups"\n${backupFlow()}` }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.equal(archives(run, ".hermes/backups").length, 1);
    });
  });
  it("an unreachable SSH host aborts at the very first block", async () => {
    await scenario({ name: "bk-ssh", seed: SEED, knobs: { ssh_down: true }, script: backupFlow() }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /ABORT: SSH/);
    });
  });
  it("a Hermes that is not 0.22.5 stops the procedure before any native call", async () => {
    await scenario({ name: "bk-ver", seed: SEED, files: { "hermes.version": "hermes 0.17.1\n" }, script: backupFlow() }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /ABORT: .*0\.22\.5/);
      noRemoteWrites(run);
    });
  });
});

describe("hermes-backup: optional off-box copy is rsync-only and explicit", { concurrency: 6 }, () => {
  const rsyncStub = '#!/bin/bash\nprintf "rsync %s\\n" "$*" >> "$HOME/logs/rsync.log"\n[ -f "$HOME/knobs/rsync_fail" ] && exit 23\nexit 0\n';
  const withRsync = (sb) => sb.write("remote_bin/rsync", rsyncStub, 0o755);
  const flow7 = () => script([...TAKE, "step7#1"]);
  it("copies the verified archive with BatchMode ssh; the target is shown in the dry run", async () => {
    await scenario({ name: "bk-rsync", seed: SEED, setup: withRsync, script: flow7(), env: { OFFBOX_TARGET: "backup@vault.example.test:/srv/hermes/" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      const log = run.sb.log("rsync.log");
      assert.match(log, /rsync -a --partial -e ssh -o BatchMode=yes .*hermes-backup-.*\.zip backup@vault\.example\.test:\/srv\/hermes\//);
      assert.match(run.out, /DRY RUN[\s\S]*vault\.example\.test/);
      assert.match(run.out, /unencrypted/i);
      assert.match(run.out, /OK: copied/);
    });
  });
  it("a failed copy is a failure (the local archive stays)", async () => {
    await scenario({ name: "bk-rsync-fail", seed: SEED, setup: (sb) => { withRsync(sb); sb.knob("rsync_fail"); }, script: flow7(), env: { OFFBOX_TARGET: "backup@vault.example.test:/srv/" } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /FAIL: .*copy/i);
      assert.equal(archives(run).length, 1);
    });
  });
  for (const [label, target] of [
    ["a git remote", "git:git@github.com:me/private.git"],
    ["an https URL", "https://github.com/me/repo.git"],
    ["an s3 URI", "s3://bucket/key"],
    ["shell metacharacters", "host:/x; touch /tmp/pwned"],
    ["an option", "-e sh"],
  ]) {
    it(`${label} is refused before any backup is taken`, async () => {
      await scenario({ name: "bk-offbox-bad", seed: SEED, setup: withRsync, script: flow7(), env: { OFFBOX_TARGET: target } }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, /OFFBOX_TARGET/);
        noRemoteWrites(run);
        assert.equal(run.sb.log("rsync.log"), "");
      });
    });
  }
});

describe("hermes-backup: restore is destructive and gated", { concurrency: 4 }, () => {
  const MUTATED = "MUTATED_AFTER_BACKUP=1\n";
  // take a backup, change the live .env, then run the restore blocks against the archive just taken
  const restoreFlow = ({ replace = [], extra = "" } = {}) =>
    assemble([
      "set +e\n",
      { skill: SKILL, ids: PRE, replace },
      { skill: SKILL, ids: TAKE, replace },
      `printf '%s' '${MUTATED}' > "$HOME/.hermes/.env"\n`,
      'RESTORE_FROM="$ARCHIVE"\n',
      extra,
      { skill: SKILL, ids: RESTORE, replace },
      SCRIPT_END,
    ]);

  it("without RESTORE_ACKNOWLEDGED=1 nothing is touched - and AUTO_APPROVE=1 does not stand in for it", async () => {
    await scenario({ name: "rs-gate", seed: SEED, script: restoreFlow(), env: { AUTO_APPROVE: "1" } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /ABORT: .*RESTORE_ACKNOWLEDGED=1/);
      assert.match(run.out, /AUTO_APPROVE does not/i);
      assert.deepEqual(calls(run).filter((c) => /^(import|gateway)/.test(c)), []);
      assert.equal(calls(run).filter((c) => c.startsWith("backup")).length, 1, "only the first (requested) backup, no safety backup, no restore");
      assert.equal(run.sb.read(".hermes/.env"), MUTATED);
    });
  });

  it("acknowledged: safety backup, then gateway stop, then `import --force`, then readiness - and the archived state is back", async () => {
    await scenario({ name: "rs-good", seed: SEED, script: restoreFlow(), env: { RESTORE_ACKNOWLEDGED: "1" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.ok(run.completed);
      assert.match(run.out, /OK: restore complete/);
      const ev = run.sb.events();
      const backups = ev.map((e, i) => [e, i]).filter(([e]) => e === "hermes backup").map(([, i]) => i);
      assert.equal(backups.length, 2, "requested backup + pre-restore safety backup");
      const stop = idx(ev, /^hermes gateway stop/, backups[1]);
      const imp = idx(ev, /^hermes import/);
      const ensure = idx(ev, /^hermes gateway ensure/, imp);
      assert.ok(backups[1] < stop && stop < imp && imp < ensure, `order backup < stop < import < ensure: ${ev}`);
      const c = calls(run);
      const safety = c.filter((x) => x.startsWith("backup"))[1];
      assert.match(safety, /^backup -o .*\/pre-restore-.*\.zip$/, "pre-restore archive must not carry the hermes-backup- prefix, or native -k pruning could delete it");
      assert.ok(c.some((x) => /^import --force \S+\.zip$/.test(x)) || c.some((x) => /^import \S+\.zip --force$/.test(x)), `import must be non-interactive: ${c}`);
      assert.equal(run.sb.read(".hermes/.env"), SEED.env, "the archived .env is back");
      assert.equal(run.sb.mode(".hermes/.env"), 0o600);
      assert.ok(run.sb.ls("hermes-backups").some((n) => n.startsWith("pre-restore-")));
      assertSecretsNotPrinted(run, [SECRET]);
    });
  });

  it("GW_INTERRUPT is the only way to stop a gateway with live sessions; the refusal stops the restore before import", async () => {
    await scenario({ name: "rs-live", seed: SEED, knobs: { live_sessions: true }, script: restoreFlow(), env: { RESTORE_ACKNOWLEDGED: "1" } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /GW_INTERRUPT=1/);
      assert.ok(!calls(run).some((c) => c.startsWith("import")));
      assert.equal(run.sb.read(".hermes/.env"), MUTATED, "nothing restored");
    });
    await scenario({ name: "rs-live-int", seed: SEED, knobs: { live_sessions: true }, script: restoreFlow(), env: { RESTORE_ACKNOWLEDGED: "1", GW_INTERRUPT: "1" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.ok(calls(run).includes("gateway stop -y"));
    });
  });

  it("a failed safety backup stops everything: no gateway stop, no import", async () => {
    await scenario({ name: "rs-nosafety", seed: SEED, script: restoreFlow({ extra: 'touch "$HOME/knobs/backup_locked"\n' }), env: { RESTORE_ACKNOWLEDGED: "1" } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /safety backup/i);
      assert.ok(!calls(run).some((c) => c.startsWith("import") || c.startsWith("gateway stop")));
      assert.equal(run.sb.read(".hermes/.env"), MUTATED);
    });
  });

  it("an import that fails says where the safety backup is and does not claim success", async () => {
    await scenario({ name: "rs-corrupt", seed: SEED, script: restoreFlow({ extra: 'touch "$HOME/knobs/import_corrupt"\n' }), env: { RESTORE_ACKNOWLEDGED: "1" } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /FAIL: hermes import/);
      assert.match(run.out, /pre-restore-.*\.zip/);
      assert.ok(!/OK: restore complete/.test(run.out));
    });
  });

  it("a gateway that never becomes ready is reported with the recovery archive", async () => {
    await scenario({ name: "rs-notready", seed: SEED, script: restoreFlow({ extra: 'touch "$HOME/knobs/ensure_exit"; echo 5 > "$HOME/knobs/ensure_exit"\n' }), env: { RESTORE_ACKNOWLEDGED: "1" } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /gateway did not become ready/i);
      assert.match(run.out, /pre-restore-.*\.zip/);
    });
  });

  for (const [label, from, re] of [
    ["a relative path", "backup.zip", /RESTORE_FROM/],
    ["a path with a quote", "/tmp/a'b.zip", /RESTORE_FROM/],
    ["a non-zip name", "/tmp/archive.tar.gz", /RESTORE_FROM/],
    ["a missing file", "/nonexistent/hermes-backup-x.zip", /not found|missing/i],
  ]) {
    it(`RESTORE_FROM as ${label}: ABORT before the safety backup`, async () => {
      const s = assemble(["set +e\n", { skill: SKILL, ids: PRE }, `RESTORE_FROM="${from}"\n`, { skill: SKILL, ids: ["restore-1#1"] }, SCRIPT_END]);
      await scenario({ name: "rs-from", seed: SEED, script: s, env: { RESTORE_ACKNOWLEDGED: "1" } }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, re);
        assert.match(run.out, /Nothing was changed/);
        noRemoteWrites(run);
        assertStateIdentical(run);
      });
    });
  }
});

describe("hermes-backup: mutation controls (each guard is load-bearing)", { concurrency: 4 }, () => {
  const control = (name, part, mutate, check) =>
    it(name, async () => {
      mustReplace({ skill: SKILL, ids: part.ids, replace: mutate });
      await scenario({ name: "bk-ctl", seed: SEED, script: part.script(mutate), env: part.env || {} }, check);
    });

  control("without `umask 077` the archive is world-readable", { ids: ["step5#1"], script: (r) => script(TAKE.slice(0, 5), { replace: r }) }, [["umask 077; ", ""]], async (run) => {
    const list = archives(run);
    assert.equal(list.length, 1, run.out);
    assert.notEqual(run.sb.mode(`hermes-backups/${list[0]}`), 0o600, "the control must expose the 0644 archive");
  });
  control("without `-k` the native default (3) would silently prune a longer retention", { ids: ["step5#1"], script: (r) => script(TAKE.slice(0, 5), { replace: r }) }, [[" -k $KEEP", ""]], async (run) => {
    assert.ok(!calls(run).some((c) => / -k /.test(c)), "control applied");
  });
  control("without `--force` the import aborts on EOF (no TTY)", {
    ids: ["restore-5#1"],
    script: (r) => assemble(["set +e\n", { skill: SKILL, ids: PRE, replace: r }, { skill: SKILL, ids: TAKE, replace: r }, `printf 'X=1\\n' > "$HOME/.hermes/.env"\nRESTORE_FROM="$ARCHIVE"\n`, { skill: SKILL, ids: RESTORE, replace: r }, SCRIPT_END]),
    env: { RESTORE_ACKNOWLEDGED: "1" },
  }, [["import --force", "import"], ["--force", ""]], async (run) => {
    assert.equal(run.code, 1, run.out);
    assert.match(run.out, /Aborted|FAIL: hermes import/);
  });
  control("without the gate a bare run would restore", {
    ids: ["restore-2#1"],
    script: (r) => assemble(["set +e\n", { skill: SKILL, ids: PRE, replace: r }, { skill: SKILL, ids: TAKE, replace: r }, 'RESTORE_FROM="$ARCHIVE"\n', { skill: SKILL, ids: RESTORE, replace: r }, SCRIPT_END]),
  }, [['[ "${RESTORE_ACKNOWLEDGED:-}" = 1 ]', "true"]], async (run) => {
    assert.ok(calls(run).some((c) => c.startsWith("import")), "control applied: import ran without the gate");
  });
});

describe("hermes-backup: static facts about the text", () => {
  const text = readFileSync(skillPath(SKILL), "utf8");
  it("no hand-rolled archive, retention or git push: tar, find -delete/-mtime, git remote and push are gone", () => {
    const code = text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    const fences = [...code.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]).join("\n");
    assert.doesNotMatch(fences, /\btar\s+[a-z-]*[cz]/, "tar archive");
    assert.doesNotMatch(fences, /-mtime|-delete|\brm\s+-r?f?\s+\S*hermes-backup/, "own retention");
    assert.doesNotMatch(fences, /\bgit\s+(init|add|commit|push|remote)/, "git push of the archive");
  });
  it("states the automatic-backup truth instead of 'Hermes ships no automatic backups'", () => {
    assert.doesNotMatch(text, /ships\s+\*?\*?no automatic backups/i);
    assert.match(text, /pre_update_backup/);
    assert.match(text, /state-snapshots/);
  });
  it("cites the source it was verified against and says what was not run", () => {
    assert.match(text, /## Verified against Hermes v0\.22\.5/);
    assert.match(text, /hermes_cli\/backup\.py:\d+/);
    assert.match(text, /\*\*Not verified:\*\*[\s\S]*real Hermes/);
  });
  it("tells the operator to schedule through /hermes-cron instead of installing cron itself", () => {
    assert.match(text, /\/hermes-cron/);
    assert.doesNotMatch(text, /crontab|cron create/);
  });
});
