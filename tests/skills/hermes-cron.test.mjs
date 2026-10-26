// hermes-cron: the real SKILL.md blocks against a simulated VPS (helpers/sandbox.mjs) whose `hermes cron` double
// (stub-commands/cron.sh) prints the v0.22.5 output strings quoted in its header. Syntax is checked by the real argparse.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { assertSecretsNotPrinted, assertStateIdentical, idx } from "./helpers/asserts.mjs";
import { assemble, loadBlocks, mustReplace, skillPath } from "./helpers/blocks.mjs";
import { SCRIPT_END, scenario } from "./helpers/sandbox.mjs";
import { fake } from "./helpers/tokens.mjs";

const SKILL = "hermes-cron";
const HEAD = ["before-you-start#1", "step0#1", "step1#1", "step2#1", "step3#1"];
const ALL = [...HEAD, "step4#1", "step5#1", "step6#1", "step7#1"];

const flow = ({ ids = ALL, replace = [] } = {}) => assemble(["set +e\n", { skill: SKILL, ids, replace }, SCRIPT_END]);
const SEED = { env: "PUBLIC_FIXTURE=keep\n", config: "model.default: prior/model\n", crontab: "0 1 * * * prior-command\n" };

const AGENT = { CRON_KIND: "agent", CRON_NAME: "daily-digest", CRON_SCHEDULE: "every 6h", CRON_PROMPT: "Summarise yesterday's deploy notes" };
const BACKUP = { CRON_KIND: "backup" };
const SESSIONS = { CRON_KIND: "sessions", PRUNE_DAYS: "30" };
const SCRIPTJOB = { CRON_KIND: "script", CRON_NAME: "watchdog", CRON_SCHEDULE: "every 5m", CRON_SCRIPT: "watch.sh" };
const WATCH = { ".hermes/scripts/watch.sh": "#!/bin/bash\necho disk ok\n" };

const jobDir = (id) => `.hermes/cron/jobs/${id}`;
const jobs = (sb) =>
  sb.ls(".hermes/cron/jobs").map((id) => {
    const f = (k) => sb.read(`${jobDir(id)}/${k}`);
    return { id, name: f("name"), prompt: f("prompt"), script: f("script"), noAgent: f("no_agent"), deliver: f("deliver"), schedule: f("schedule"), state: f("state") };
  });
const seedJob = (sb, id, o = {}) => {
  const d = { name: "other-job", prompt: "do a thing", script: "", no_agent: "0", state: "active", schedule: "every 60m", deliver: "local", ...o };
  for (const [k, v] of Object.entries(d)) sb.write(`${jobDir(id)}/${k}`, v);
};
const cronCalls = (run, sub) => run.sb.hermesCalls().filter((c) => c[0] === "cron" && (!sub || c[1] === sub));
const creates = (run) => cronCalls(run, "create");
const writesAfterVersionGate = (run) => run.sb.events().filter((e) => /^hermes (cron (create|remove)|gateway (restart|stop|run)|config set)/.test(e));

// the gateway lifecycle guard (cron/lifecycle_guard.py:30-67), as a JS port of branches A-D with and without the -p NAME option
const GUARD = [
  /(?<![/\w.-])hermes(?:\.(?:exe|cmd|bat|com|ps1))?\s+(?:-p\s+\S+\s+|--profile\s+\S+\s+)?gateway\s+(?:restart|stop|uninstall)\b/i,
  /launchctl\s+(?:kickstart|unload|load|stop|restart|submit|bootstrap|bootout|remove|disable)\b[^\n]*\bhermes[.-]?gateway/i,
  /systemctl\s+(?:-\S+\s+)*(?:restart|stop|start)\b[^\n]*\bhermes[.-]?gateway/i,
  /\b(?:p?kill|taskkill|stop-process)\b[^\n]*\bhermes\b[^\n]*\bgateway/i,
];
const guardHits = (text) => GUARD.filter((re) => re.test(text)).length;
const allStoredText = (run) => {
  const parts = [];
  for (const j of jobs(run.sb)) parts.push(j.prompt, j.script);
  for (const f of run.sb.ls(".hermes/scripts")) parts.push(run.sb.read(`.hermes/scripts/${f}`));
  return parts.join("\n");
};

// ---------------------------------------------------------------------------------------------------------------------
describe("hermes-cron: agent job, happy path", { concurrency: 4 }, () => {
  it("creates exactly one job after the gateway is ready, reads its id from `Created job:`, verifies it, and touches no env/config/crontab", async () => {
    await scenario({ name: "cron-agent", seed: SEED, script: flow(), env: AGENT }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.ok(run.completed);
      const c = creates(run);
      assert.equal(c.length, 1);
      assert.deepEqual(c[0], ["cron", "create", "every 6h", "Summarise yesterday's deploy notes", "--name", "daily-digest", "--deliver", "local"]);
      const js = jobs(run.sb);
      assert.equal(js.length, 1);
      assert.match(js[0].id, /^[0-9a-f]{12}$/);
      assert.equal(js[0].name, "daily-digest");
      assert.match(run.out, new RegExp(`OK: created job ${js[0].id} \\(daily-digest\\)`));
      assert.match(run.out, new RegExp(`OK: job ${js[0].id} is listed and cron doctor has no finding`));
      const ev = run.sb.events();
      assert.ok(idx(ev, /^hermes gateway ensure/) >= 0 && idx(ev, /^hermes gateway ensure/) < idx(ev, /^hermes cron create/), "gateway readiness is checked BEFORE the job is created");
      assert.ok(idx(ev, /^hermes cron list/) < idx(ev, /^hermes cron create/), "the name lookup comes before create");
      assert.ok(cronCalls(run, "list").every((l) => l.includes("--all")), "disabled and completed jobs count for the name lookup");
      assert.ok(cronCalls(run, "doctor").length >= 1);
      assert.equal(cronCalls(run, "run").length, 0, "no manual run unless SMOKE_RUN=1");
      assert.ok(!ev.some((e) => /^hermes gateway (restart|stop|run)/.test(e)), "creating a job never restarts the gateway");
      assert.ok(!run.sb.log("hermes-profile.log").includes("unbound"), "every hermes call is bound to the default profile");
      assertStateIdentical(run, "cron must not change .env, config.yaml or the crontab");
    });
  });

  it("the prompt reaches the job byte for byte (quotes, $ and backticks are not expanded by either shell)", async () => {
    const prompt = `Say it's "done"; print $HOME and \`date\` then stop`;
    await scenario({ name: "cron-quote", seed: SEED, script: flow(), env: { ...AGENT, CRON_PROMPT: prompt } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.equal(jobs(run.sb)[0].prompt, prompt);
      assert.equal(creates(run)[0][3], prompt);
    });
  });

  it("a cron expression, a delivery target and a failure target are passed as separate native flags", async () => {
    await scenario({ name: "cron-flags", seed: SEED, script: flow(), env: { ...AGENT, CRON_SCHEDULE: "0 9 * * 1-5", CRON_DELIVER: "telegram:-100123", CRON_FAILURE_DELIVER: "local" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.deepEqual(creates(run)[0], ["cron", "create", "0 9 * * 1-5", AGENT.CRON_PROMPT, "--name", "daily-digest", "--deliver", "telegram:-100123", "--failure-deliver", "local"]);
    });
  });

  it("the dry run states the standing rule, schedule, timezone source, delivery and the exact prompt before anything is created", async () => {
    await scenario({ name: "cron-dry", seed: SEED, script: flow({ ids: [...HEAD, "step4#1"] }), env: AGENT }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /DRY RUN/);
      assert.match(run.out, /Standing rule: job 'daily-digest' will run UNATTENDED on schedule 'every 6h'/);
      assert.match(run.out, /\| Summarise yesterday's deploy notes/);
      assert.match(run.out, /Timezone Hermes reads the schedule in:/);
      assert.match(run.out, /Output goes to: local \(local = saved on the VPS only/);
      assert.equal(creates(run).length, 0, "nothing is created before the approval step");
      assertStateIdentical(run);
    });
  });

  it("SMOKE_RUN=1 runs the agent job once and reports the scheduler-tick verdict; it is off by default", async () => {
    await scenario({ name: "cron-smoke-agent", seed: SEED, script: flow(), env: { ...AGENT, SMOKE_RUN: "1" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.equal(cronCalls(run, "run").length, 1);
      assert.match(run.out, /Triggered job: daily-digest/);
      assert.match(run.out, /queued for the next scheduler tick/);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("hermes-cron: input validation happens before any remote write", { concurrency: 6 }, () => {
  const refuse = (name, env, re, extra = {}) =>
    it(name, async () => {
      await scenario({ name: "cron-bad", seed: SEED, script: flow(), env: { ...AGENT, ...env }, ...extra }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, re);
        assert.match(run.out, /Nothing was written\./);
        assert.deepEqual(writesAfterVersionGate(run), []);
        assert.equal(jobs(run.sb).length, 0);
        assertStateIdentical(run);
      });
    });
  refuse("unknown kind", { CRON_KIND: "restart" }, /CRON_KIND must be agent, script, backup or sessions/);
  refuse("a name with a space or shell character", { CRON_NAME: "my job; rm -rf" }, /CRON_NAME must be 1-50 characters/);
  refuse("a name longer than 50 characters", { CRON_NAME: "n".repeat(51) }, /longer than 50/);
  refuse("an empty schedule", { CRON_SCHEDULE: "" }, /CRON_SCHEDULE is empty or has unexpected characters/);
  refuse("a schedule with quotes", { CRON_SCHEDULE: "every 1h' ; touch x" }, /CRON_SCHEDULE is empty or has unexpected characters/);
  refuse("a delivery target with a space", { CRON_DELIVER: "telegram chat" }, /CRON_DELIVER has unexpected characters/);
  refuse("an agent job without a prompt", { CRON_PROMPT: "" }, /needs CRON_PROMPT/);
  refuse("a prompt that carries a token", { CRON_PROMPT: `call the api with ${fake.github("P")} each hour` }, /looks like it contains a credential/);
  refuse("a prompt that carries a key=value credential", { CRON_PROMPT: "login with password: hunter2hunter2" }, /looks like it contains a credential/);
  refuse("a prompt that restarts the gateway", { CRON_PROMPT: "Every night run hermes gateway restart to recycle memory" }, /gateway restart\/stop command; Hermes rejects those/);
  refuse("the same with the profile option between the words", { CRON_PROMPT: "then hermes -p default gateway stop" }, /gateway restart\/stop command/);

  it("the token never appears in the output, in any argv or in the job store when the prompt is refused", async () => {
    const token = fake.github("Q");
    await scenario({ name: "cron-secret", seed: SEED, script: flow(), env: { ...AGENT, CRON_PROMPT: `use ${token}` } }, async (run) => {
      assert.equal(run.code, 1);
      assertSecretsNotPrinted(run, [token]);
      assert.ok(!run.sb.log("hermes-argv.log").includes(token));
      assert.ok(!run.sb.log("ssh-argv.log").includes(token));
    });
  });

  it("a Hermes that is not 0.22.5 stops the run at the version gate", async () => {
    const replace = [["v?0[.]22[.]5([[:space:]]|$)", "v?9[.]9[.]9([[:space:]]|$)"]];
    mustReplace({ skill: SKILL, ids: ["step1#1"], replace });
    await scenario({ name: "cron-version", seed: SEED, script: flow({ replace }), env: AGENT }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /source-verified for Hermes 0\.22\.5 only/);
      assert.equal(creates(run).length, 0);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("hermes-cron: idempotency by job name (cron create never dedupes)", { concurrency: 4 }, () => {
  it("an existing job with the same name: exit 0, no gateway call, no create, state untouched", async () => {
    await scenario({ name: "cron-idem", seed: SEED, script: flow(), env: AGENT, setup: (sb) => seedJob(sb, "abcdef012345", { name: "daily-digest" }) }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.ok(!run.completed, "the flow stops at the idempotency check");
      assert.match(run.out, /A job named 'daily-digest' already exists \(id: abcdef012345\)/);
      assert.equal(creates(run).length, 0);
      assert.equal(jobs(run.sb).length, 1);
      assert.ok(!run.sb.events().some((e) => e.startsWith("hermes gateway")), "no gateway call before the lookup decides");
    });
  });

  it("the lookup includes disabled jobs (--all) and is exact: similar names and a job named like the prompt do not block", async () => {
    await scenario({
      name: "cron-idem-near", seed: SEED, script: flow(), env: AGENT,
      setup: (sb) => {
        seedJob(sb, "aaaaaaaaaaaa", { name: "daily-digest-2" });
        seedJob(sb, "bbbbbbbbbbbb", { name: AGENT.CRON_PROMPT });
        seedJob(sb, "cccccccccccc", { name: "daily.digest" });
      },
    }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.equal(creates(run).length, 1);
      const mine = jobs(run.sb).filter((j) => j.name === "daily-digest");
      assert.equal(mine.length, 1);
      assert.match(run.out, new RegExp(`created job ${mine[0].id}`), "the new id is the one printed by create, not an id of a similar job");
      assert.equal(jobs(run.sb).length, 4);
    });
    await scenario({ name: "cron-idem-paused", seed: SEED, script: flow(), env: AGENT, setup: (sb) => seedJob(sb, "dddddddddddd", { name: "daily-digest", state: "paused" }) }, async (run) => {
      assert.equal(run.code, 0);
      assert.match(run.out, /already exists \(id: dddddddddddd\)/, "a paused job still counts");
    });
  });

  it("running the whole flow twice creates one job", async () => {
    const twice = assemble(["set +e\n", { skill: SKILL, ids: ALL }, { skill: SKILL, ids: HEAD.slice(2) }, SCRIPT_END]);
    await scenario({ name: "cron-twice", seed: SEED, script: twice, env: AGENT }, async (run) => {
      assert.equal(jobs(run.sb).length, 1);
      assert.equal(creates(run).length, 1);
      assert.match(run.out, /already exists/);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("hermes-cron: scheduler prerequisites and failures after the first write", { concurrency: 4 }, () => {
  it("a gateway that never becomes ready aborts BEFORE the script is written or the job created", async () => {
    await scenario({ name: "cron-gw", seed: SEED, script: flow(), env: BACKUP, knobs: { ensure_exit: "3" } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /the gateway \(cron scheduler host\) is not ready/);
      assert.equal(creates(run).length, 0);
      assert.ok(!run.sb.exists(".hermes/scripts/hstack-backup.sh"));
      assertStateIdentical(run);
    });
  });

  it("a refused schedule is reported with Hermes' own words and leaves nothing behind (preset script removed)", async () => {
    await scenario({ name: "cron-badsched", seed: SEED, script: flow(), env: { ...BACKUP, CRON_SCHEDULE: "banana" } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /FAIL: cron create was refused: Failed to create job: Invalid schedule 'banana'/);
      assert.equal(jobs(run.sb).length, 0);
      assert.ok(!run.sb.exists(".hermes/scripts/hstack-backup.sh"), "the script this run wrote is removed");
      assert.match(run.out, /undo: removed what this run created/);
    });
  });

  it("a cron expression on a host without croniter is refused and undone", async () => {
    await scenario({ name: "cron-nocroniter", seed: SEED, script: flow(), env: { ...AGENT, CRON_SCHEDULE: "0 9 * * *" }, knobs: { cron_no_croniter: true } }, async (run) => {
      assert.equal(run.code, 1);
      assert.match(run.out, /croniter/);
      assert.equal(jobs(run.sb).length, 0);
    });
  });

  it("a job that cannot be read back is undone by exact id: only the job this run created is removed, other jobs stay", async () => {
    await scenario({
      name: "cron-undo", seed: SEED, script: flow(), env: AGENT, knobs: { cron_list_hide: true },
      setup: (sb) => { seedJob(sb, "111111111111", { name: "keep-a" }); seedJob(sb, "222222222222", { name: "keep-b", state: "paused" }); },
    }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /FAIL: job [0-9a-f]{12} is not in 'cron list --all'\./);
      const left = jobs(run.sb).map((j) => j.id).sort();
      assert.deepEqual(left, ["111111111111", "222222222222"]);
      const rm = cronCalls(run, "remove");
      assert.equal(rm.length, 1);
      assert.match(rm[0][2], /^c0ffee[0-9a-f]{6}$/, "removed by the id parsed from `Created job:`, never by name or prompt");
      assert.match(run.out, /undo: removed what this run created/);
    });
  });

  it("a preset script that already exists with the same content is reused and survives the undo", async () => {
    // capture the exact script text from a first successful run, then re-run with it already on the VPS and a failing read-back
    let text = "";
    await scenario({ name: "cron-script-text", seed: SEED, script: flow(), env: BACKUP }, async (run) => { text = run.sb.read(".hermes/scripts/hstack-backup.sh"); });
    assert.match(text, /^#!\/bin\/bash/);
    await scenario({ name: "cron-script-reuse", seed: SEED, script: flow(), env: BACKUP, knobs: { cron_list_hide: true }, files: { ".hermes/scripts/hstack-backup.sh": text } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.equal(run.sb.read(".hermes/scripts/hstack-backup.sh"), text, "an identical script that was already there is not ours to delete");
      assert.equal(jobs(run.sb).length, 0);
    });
  });

  it("a preset script that exists with DIFFERENT content is never overwritten", async () => {
    await scenario({ name: "cron-script-clash", seed: SEED, script: flow(), env: BACKUP, files: { ".hermes/scripts/hstack-backup.sh": "#!/bin/bash\necho mine\n" } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /already exists with different content/);
      assert.equal(run.sb.read(".hermes/scripts/hstack-backup.sh"), "#!/bin/bash\necho mine\n");
      assert.equal(creates(run).length, 0);
    });
  });

  it("cron doctor findings about OTHER jobs are a warning, findings about the new job are a failure", async () => {
    await scenario({ name: "cron-doctor-other", seed: SEED, script: flow(), env: AGENT, setup: (sb) => seedJob(sb, "999999999999", { name: "broken", script: "gone.sh", no_agent: "1" }) }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /WARN: cron doctor reports problems with OTHER jobs/);
      assert.equal(jobs(run.sb).filter((j) => j.name === "daily-digest").length, 1);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("hermes-cron: user scripts (no-agent)", { concurrency: 4 }, () => {
  it("--script and --no-agent are passed, the list shows the no-agent mode, and no prompt is sent", async () => {
    await scenario({ name: "cron-script", seed: SEED, script: flow(), env: SCRIPTJOB, files: WATCH }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.deepEqual(creates(run)[0], ["cron", "create", "every 5m", "--script", "watch.sh", "--no-agent", "--name", "watchdog", "--deliver", "local"]);
      const j = jobs(run.sb)[0];
      assert.equal(j.noAgent, "1");
      assert.equal(j.prompt, "");
      assert.equal(j.script, "watch.sh");
    });
  });
  it("a missing script, a path and a traversal are refused before anything is created", async () => {
    for (const env of [{ CRON_SCRIPT: "missing.sh" }, { CRON_SCRIPT: "../evil.sh" }, { CRON_SCRIPT: "/etc/passwd" }, { CRON_SCRIPT: "a b.sh" }, { CRON_SCRIPT: ".hidden.sh" }, { CRON_SCRIPT: "x.rb" }]) {
      await scenario({ name: "cron-script-bad", seed: SEED, script: flow(), env: { ...SCRIPTJOB, ...env }, files: WATCH }, async (run) => {
        assert.equal(run.code, 1, `${JSON.stringify(env)}: ${run.out}`);
        assert.match(run.out, /ABORT: CRON_SCRIPT|does not exist in ~\/\.hermes\/scripts/);
        assert.equal(creates(run).length, 0);
      });
    }
  });
  it("a user script that restarts the gateway is refused by Hermes' guard and the refusal is surfaced", async () => {
    await scenario({ name: "cron-script-guard", seed: SEED, script: flow(), env: SCRIPTJOB, files: { ".hermes/scripts/watch.sh": "#!/bin/bash\nhermes gateway restart\n" } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /Blocked: cron job contains a gateway lifecycle command/);
      assert.equal(jobs(run.sb).length, 0);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("hermes-cron: the old reliability defaults are replaced by native no-agent jobs", { concurrency: 4 }, () => {
  it("backup: a 700 script runs the native `hermes backup -o DIR -k N`; the job is no-agent with no prompt (no LLM over ~/.hermes)", async () => {
    await scenario({ name: "cron-backup", seed: SEED, script: flow(), env: { ...BACKUP, BACKUP_KEEP: "5" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.deepEqual(creates(run)[0], ["cron", "create", "every 1d", "--script", "hstack-backup.sh", "--no-agent", "--name", "hstack-backup", "--deliver", "local"]);
      const j = jobs(run.sb)[0];
      assert.equal(j.noAgent, "1");
      assert.equal(j.prompt, "", "no prompt: nothing for an LLM to improvise with");
      const script = run.sb.read(".hermes/scripts/hstack-backup.sh");
      assert.equal(run.sb.mode(".hermes/scripts/hstack-backup.sh"), 0o700);
      assert.match(script, /"\$HB" -p default backup -o "\$OUT" -k 5 >\/dev\/null/);
      assert.match(script, /umask 077/);
      assert.match(script, /chmod 700 "\$OUT"/);
      const body = script.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
      assert.doesNotMatch(body, /\bgit\b|curl|wget|scp|rsync|gateway|\btar\b|\bzip\b/, "no push, no upload, no hand-rolled archive, no gateway command");
      assert.equal(guardHits(allStoredText(run)), 0);
      assert.match(run.out, /each archive contains ~\/\.hermes\/\.env and auth\.json/);
    });
  });

  it("backup: SMOKE_RUN=1 really runs the script through the cron double: a private zip appears in ~/.hermes/backups", async () => {
    await scenario({ name: "cron-backup-run", seed: SEED, script: flow(), env: { ...BACKUP, SMOKE_RUN: "1" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /Ran now: succeeded/);
      const zips = run.sb.ls(".hermes/backups").filter((f) => /^hermes-backup-.*\.zip$/.test(f));
      assert.equal(zips.length, 1, run.out);
      assert.equal(run.sb.mode(".hermes/backups"), 0o700);
      assert.equal(run.sb.mode(`.hermes/backups/${zips[0]}`) & 0o077, 0, "the archive holds .env: no group/other access");
      assert.match(run.sb.log("hermes-argv.log"), /backup\t-o\t[^\t]*\/\.hermes\/backups\t-k\t7/);
    });
  });

  it("backup keep and sessions days must be whole numbers in range; sessions has NO default", async () => {
    for (const [env, re] of [[{ ...BACKUP, BACKUP_KEEP: "0" }, /BACKUP_KEEP must be between 1 and 365/], [{ ...BACKUP, BACKUP_KEEP: "x" }, /BACKUP_KEEP must be a whole number/],
      [{ CRON_KIND: "sessions" }, /needs PRUNE_DAYS .* no default/], [{ ...SESSIONS, PRUNE_DAYS: "0" }, /PRUNE_DAYS must be between/], [{ ...SESSIONS, PRUNE_DAYS: "-5" }, /needs PRUNE_DAYS/]]) {
      await scenario({ name: "cron-num", seed: SEED, script: flow(), env }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, re);
        assert.match(run.out, /Nothing was written\./);
        assert.equal(creates(run).length, 0);
        assert.ok(!run.sb.exists(".hermes/scripts"));
      });
    }
  });

  it("sessions: the job is no-agent and the dry run warns about irreversible deletion; SMOKE_RUN prunes only ended, unpinned, older sessions", async () => {
    const db = "s-new\t10\t1\t0\ns-old\t31\t1\t0\ns-pinned\t90\t1\t1\ns-open\t120\t0\t0\ns-ancient\t400\t1\t0\n";
    await scenario({ name: "cron-sessions", seed: SEED, script: flow(), env: { ...SESSIONS, SMOKE_RUN: "1" }, files: { "sessions.db": db } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /permanently DELETES ended, unpinned sessions older than 30 days/);
      assert.deepEqual(creates(run)[0], ["cron", "create", "every 7d", "--script", "hstack-sessions-prune.sh", "--no-agent", "--name", "hstack-sessions-prune", "--deliver", "local"]);
      assert.equal(jobs(run.sb)[0].noAgent, "1");
      assert.match(run.sb.read(".hermes/scripts/hstack-sessions-prune.sh"), /"\$HB" -p default sessions prune --older-than 30 --yes >\/dev\/null/);
      assert.equal(run.sb.read("sessions.db"), "s-new\t10\t1\t0\ns-pinned\t90\t1\t1\ns-open\t120\t0\t0\n");
      assert.match(run.sb.log("sessions-prune.log"), /older=30 dry=0 yes=1/);
      assert.equal(guardHits(allStoredText(run)), 0);
    });
  });

  it("sessions: without SMOKE_RUN nothing is deleted at creation time", async () => {
    const db = "s-old\t99\t1\t0\n";
    await scenario({ name: "cron-sessions-nodel", seed: SEED, script: flow(), env: SESSIONS, files: { "sessions.db": db } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.equal(run.sb.read("sessions.db"), db);
      assert.equal(run.sb.log("sessions-prune.log"), "");
      assert.equal(cronCalls(run, "run").length, 0);
    });
  });

  it("no gateway restart/stop appears in ANY job text, script or hermes argv of ANY flow, and the gateway is never restarted", async () => {
    const files = { ...WATCH, "sessions.db": "" };
    for (const env of [AGENT, SCRIPTJOB, BACKUP, SESSIONS]) {
      await scenario({ name: "cron-noguard", seed: SEED, script: flow(), env, files }, async (run) => {
        assert.equal(run.code, 0, run.out);
        assert.equal(guardHits(allStoredText(run)), 0, "the lifecycle guard would reject this job");
        assert.doesNotMatch(allStoredText(run), /gateway\s+(restart|stop)/i);
        assert.ok(!run.sb.events().some((e) => /^hermes gateway (restart|stop|run)/.test(e)));
        const createArgv = creates(run).map((c) => c.join(" ")).join("\n");
        assert.doesNotMatch(createArgv, /gateway/i);
      });
    }
  });

  it("the guard port really catches the old default, so the assertions above are not vacuous", () => {
    for (const bad of ["Run hermes gateway stop then hermes gateway run", "hermes -p default gateway restart", "systemctl restart hermes-gateway", "pkill -f 'hermes gateway'"]) {
      assert.ok(guardHits(bad) > 0, bad);
    }
    assert.equal(guardHits("hermes -p default backup -o dir -k 5"), 0);
    assert.equal(guardHits("hermes -p default sessions prune --older-than 30 --yes"), 0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("hermes-cron: delivery targets", { concurrency: 4 }, () => {
  it("a bare platform name needs its home channel: refused before any write without it, accepted with it", async () => {
    await scenario({ name: "cron-home-missing", seed: SEED, script: flow(), env: { ...AGENT, CRON_DELIVER: "telegram" } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /deliver target 'telegram' means its home channel, but TELEGRAM_HOME_CHANNEL is not set\. Run \/hermes-home first/);
      assert.equal(creates(run).length, 0);
      assertStateIdentical(run);
    });
    await scenario({ name: "cron-home-set", seed: { ...SEED, env: "TELEGRAM_HOME_CHANNEL=555\n" }, script: flow(), env: { ...AGENT, CRON_DELIVER: "telegram" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.deepEqual(creates(run)[0].slice(-2), ["--deliver", "telegram"]);
      assert.ok(!run.out.includes("555"), "the chat id is never printed");
    });
  });
  it("matrix uses MATRIX_HOME_ROOM, the other platforms <PLATFORM>_HOME_CHANNEL; an explicit chat id needs no home channel; local/origin are not platforms", async () => {
    await scenario({ name: "cron-home-matrix", seed: SEED, script: flow(), env: { ...AGENT, CRON_DELIVER: "matrix" } }, async (run) => {
      assert.equal(run.code, 1);
      assert.match(run.out, /MATRIX_HOME_ROOM is not set/);
    });
    await scenario({ name: "cron-home-explicit", seed: SEED, script: flow(), env: { ...AGENT, CRON_DELIVER: "slack:C0123ABCD" } }, async (run) => assert.equal(run.code, 0, run.out));
    await scenario({ name: "cron-home-origin", seed: SEED, script: flow(), env: { ...AGENT, CRON_DELIVER: "origin" } }, async (run) => assert.equal(run.code, 0, run.out));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("hermes-cron: static facts about the text", () => {
  const text = readFileSync(skillPath(SKILL), "utf8");
  const code = loadBlocks(SKILL).map((b) => b.code).join("\n");
  it("job id capture is `Created job:` and the old greps of the prompt are gone", () => {
    assert.match(code, /Created job: /);
    assert.doesNotMatch(code, /grep -F "\$CRON_PROMPT"|awk '\/\^cron\/|awk '\{print \$1\}'/);
  });
  it("none of the three old defaults is installed: no LLM prompt about restart/push/prune, no `gateway stop`, no `install_if_absent`", () => {
    assert.doesNotMatch(code, /install_if_absent|SKIP_DEFAULTS|gateway stop|gateway run|Push changes in ~\/\.hermes|Prune session files/);
    assert.doesNotMatch(code, /#25315/);
    assert.match(text, /guard rejects it/i);
  });
  it("`--force` is never used and nothing writes .env or config.yaml", () => {
    assert.doesNotMatch(code, /--force\b|config set|>> *~?\/?\.?hermes\/\.env|echo [^\n]*>> /);
  });
  it("the text does not claim output reaches a chat by default, nor that a bare duration is a one-shot", () => {
    assert.match(text, /default is `local`/);
    assert.match(text, /bare `30m`[^\n]*RECURRING|RECURRING[^\n]*`in 30m`/);
    assert.doesNotMatch(text, /deliver results to the configured home channel/);
  });
  it("it names its source citations and what remains unverified", () => {
    assert.match(text, /## Verified against Hermes v0\.22\.5/);
    assert.match(text, /hermes_cli\/cron\.py:790-812/);
    assert.match(text, /cron\/lifecycle_guard\.py/);
    assert.match(text, /Not verified: nothing here was run against a real Hermes/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("hermes-cron: mutation controls (each guard is load-bearing)", { concurrency: 4 }, () => {
  const control = (name, ids, replace, opts, check) =>
    it(name, async () => {
      mustReplace({ skill: SKILL, ids, replace });
      await scenario({ name: "cron-ctl", seed: SEED, script: flow({ replace }), env: opts.env, files: opts.files, knobs: opts.knobs, setup: opts.setup }, check);
    });

  control("without `--no-agent` Hermes itself refuses a prompt-less job: the flag is what makes the script the job", ["step2#1"],
    [[`--script $(shq "$SCRIPT_NAME") --no-agent"`, `--script $(shq "$SCRIPT_NAME")"`]], { env: BACKUP }, async (run) => {
      assert.equal(run.code, 1, "control applied");
      assert.match(run.out, /create requires either prompt or at least one skill/);
      assert.equal(jobs(run.sb).length, 0);
    });
  control("without the name lookup a second run calls create again", ["step3#1"], [['if [ -n "$EXISTING" ]; then', "if false; then"]],
    { env: AGENT, setup: (sb) => seedJob(sb, "abcdef012345", { name: "daily-digest" }) }, async (run) => {
      assert.equal(creates(run).length, 1, "control applied: a duplicate create was attempted");
    });
  control("an undo that targets the wrong id leaves the new job scheduled", ["step0#1"],
    [['remote "hermes -p default cron remove $CREATED_ID"', 'remote "hermes -p default cron remove nonexistent-job"']],
    { env: AGENT, knobs: { cron_list_hide: true } }, async (run) => {
      assert.equal(jobs(run.sb).length, 1, "control applied: the job survived the undo");
    });
  control("without the home-channel check a bare platform target creates a job that delivers nowhere", ["step2#1"],
    [['remote "hermes -p default config get $v" >/dev/null 2>&1 \\', "true \\"]], { env: { ...AGENT, CRON_DELIVER: "telegram" } }, async (run) => {
      assert.equal(creates(run).length, 1, "control applied: created with an unresolvable delivery target");
    });
  control("without the credential heuristic a token in the prompt reaches the job store", ["step2#1"],
    [["if printf '%s\\n' \"$CRON_PROMPT\" | grep -Eq '(^|[^[:alnum:]])(sk-", "if printf '%s\\n' \"$CRON_PROMPT\" | grep -Eq '(^|[^[:alnum:]])(NEVER-"]],
    { env: { ...AGENT, CRON_PROMPT: `call with ${fake.openrouter("Z")}` } }, async (run) => {
      assert.ok(jobs(run.sb)[0]?.prompt.includes(fake.openrouter("Z")), "control applied: the token is stored in plaintext");
    });
});
