// hermes-install: the version gate, the exact installer invocation, and the Step 4 verification gate (pm doctor gates, hermes doctor is
// reported but not fatal). The installer itself is never executed: a `bash` shim on the simulated VPS records the argv/env of the
// installer invocation, and the recorded flags are then replayed against the REAL v0.22.5 installer (vendored, sha-pinned) with --help.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { assertStateIdentical } from "./helpers/asserts.mjs";
import { REPO_ROOT, assemble, loadBlocks } from "./helpers/blocks.mjs";
import { SCRIPT_END, scenario } from "./helpers/sandbox.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures/hermes-v0.22.5");
const provenance = JSON.parse(readFileSync(path.join(fixture, "provenance.json"), "utf8"));
const COMMIT = provenance.commit;
const seed = { env: "PUBLIC_FIXTURE=keep\n", config: "model.default: prior/model\n" };
const SKILL = "hermes-install";
const run = (parts) => assemble(["set +e\n", ...parts, SCRIPT_END]);
const blocks = (...ids) => ({ skill: SKILL, ids });

/** A fresh host: no launcher yet (the sandbox otherwise preinstalls the hermes stub). */
const freshHost = (sb) => rmSync(sb.p(".local/bin/hermes"));

/** The installer download is the real vendored installer bytes (so the pinned SHA-256 matches); a `bash` shim records the invocation. */
function installerShims(sb, { installerExit = 0 } = {}) {
  sb.write("remote_bin/curl", `#!/bin/bash
out=""
while [ $# -gt 0 ]; do if [ "$1" = -o ]; then shift; out="$1"; fi; shift; done
cp "${path.join(fixture, "install.sh")}" "$out"
`, 0o755);
  sb.write("remote_bin/bash", `#!/bin/bash
case " $* " in
  *" --non-interactive "*)
    { printf 'argv:'; printf ' %s' "$@"; printf '\\n'; env | grep -E '^(HERMES_REPO_URL|HERMES_INSTALL_DIR|HERMES_HOME)=' | sed 's/^/env:/'; } >> "$HOME/logs/installer.log"
    exit ${installerExit} ;;
  *) exec /bin/bash "$@" ;;
esac
`, 0o755);
}

/** Make Step 4 pass its identity checks: the git checkout reports the pinned commit, hermes reports `banner`. */
function installedHost(sb, banner = "Hermes Agent v0.22.5 (2026.10.1)") {
  sb.write("hermes.version", `${banner}\n`);
  sb.write("remote_bin/git", `#!/bin/bash\ncase "$*" in *rev-parse*) echo ${COMMIT} ;; *) exit 0 ;; esac\n`, 0o755);
  sb.write(".hermes/hermes-agent/.git/fixture", "present");
}

describe("hermes-install: Step 0 version gate", { concurrency: 6 }, () => {
  const step0 = run([blocks("step0#1")]);
  for (const v of ["0.15.2", "0.21.6", "0.23.0", "10.22.5", "0.22.50", "v0.22.5", "0.22.5 "]) {
    it(`refuses HERMES_VERSION=${JSON.stringify(v)} before any remote call`, async () => {
      await scenario({ name: "inst-ver", seed, script: step0, env: { HERMES_VERSION: v } }, async (r) => {
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, /ABORT: .*0\.22\.5/);
        assert.match(r.out, /Nothing was written/);
        assert.equal(r.sb.sshCalls().length, 0);
        assertStateIdentical(r);
      });
    });
  }

  for (const env of [{}, { HERMES_VERSION: "0.22.5" }, { HERMES_VERSION: "" }]) {
    it(`accepts ${JSON.stringify(env)} and goes on to check SSH (no CANDIDATE_ACKNOWLEDGED needed)`, async () => {
      await scenario({ name: "inst-ver-ok", seed, script: step0, env }, async (r) => {
        assert.equal(r.code, 0, r.out);
        assert.ok(r.sb.sshCalls().length >= 1, "SSH was checked");
        assert.doesNotMatch(r.out, /CANDIDATE|candidate/);
      });
    });
  }

  it("rejects a malformed SSH target without contacting it", async () => {
    await scenario({ name: "inst-tgt", seed, script: step0, env: { VPS_IP: "1.2.3.4;id" } }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /malformed SSH target/);
      assert.equal(r.sb.sshCalls().length, 0);
    });
  });
});

describe("hermes-install: Step 3 runs the pinned installer with the verified flags", { concurrency: 6 }, () => {
  const flow = run([blocks("step0#1", "step1#1", "step3#1")]);

  it("downloads, checks the SHA-256, then runs it with exactly the v0.22.5 flags; the flags are accepted by the real installer", async () => {
    await scenario({ name: "inst-flow", seed, script: flow, env: { HERMES_VERSION: "0.22.5" }, setup: (sb) => { freshHost(sb); installerShims(sb); } }, async (r) => {
      assert.equal(r.code, 0, r.out);
      const log = r.sb.log("installer.log");
      const argv = /^argv:(.*)$/m.exec(log)[1].trim().split(/\s+/);
      assert.deepEqual(argv.slice(1), ["--commit", COMMIT, "--channel", "stable", "--non-interactive", "--skip-browser", "--skip-computer-use"]);
      assert.match(log, /^env:HERMES_REPO_URL=https:\/\/github\.com\/NousResearch\/hermes-agent\.git$/m);
      assert.match(log, /^env:HERMES_HOME=.*\/\.hermes$/m);
      assert.match(log, /^env:HERMES_INSTALL_DIR=.*\/\.hermes\/hermes-agent$/m);
      // Replay the recorded flags against the vendored, sha-pinned REAL installer: unknown options would exit 1 ("unknown option").
      const replay = spawnSync("/bin/bash", [path.join(fixture, "install.sh"), ...argv.slice(1), "--help"], { encoding: "utf8" });
      assert.equal(replay.status, 0, replay.stderr);
      assert.match(replay.stdout, /--commit SHA/);
      const bad = spawnSync("/bin/bash", [path.join(fixture, "install.sh"), "--daemon"], { encoding: "utf8" });
      assert.notEqual(bad.status, 0, "control: the real installer rejects an invented flag");
    });
  });

  it("a download whose SHA-256 differs is never executed", async () => {
    const tampered = (sb) => {
      freshHost(sb); installerShims(sb);
      sb.write("remote_bin/curl", `#!/bin/bash\nout=""\nwhile [ $# -gt 0 ]; do if [ "$1" = -o ]; then shift; out="$1"; fi; shift; done\nprintf 'echo tampered\\n' > "$out"\n`, 0o755);
    };
    await scenario({ name: "inst-sha", seed, script: flow, env: { HERMES_VERSION: "0.22.5" }, setup: tampered }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /FAIL: installation incomplete/);
      assert.equal(r.sb.log("installer.log"), "");
      assertStateIdentical(r);
    });
  });

  it("an installer that fails leaves the host untouched by this skill and says to preserve ~/.hermes", async () => {
    await scenario({ name: "inst-fail", seed, script: flow, env: { HERMES_VERSION: "0.22.5" }, setup: (sb) => { freshHost(sb); installerShims(sb, { installerExit: 1 }); } }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /Preserve ~\/\.hermes/);
      assertStateIdentical(r);
    });
  });

  it("an existing launcher is refused before any download (user state preserved)", async () => {
    await scenario({ name: "inst-exists", seed, script: flow, env: { HERMES_VERSION: "0.22.5" }, setup: (sb) => installerShims(sb) }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /installation already exists/);
      assert.equal(r.sb.log("installer.log"), "");
      assert.ok(r.sb.exists(".local/bin/hermes"));
      assertStateIdentical(r);
    });
  });
});

describe("hermes-install: Step 4 verification", { concurrency: 6 }, () => {
  const gate = run([blocks("step0#1", "step4#1")]);
  const all = run([blocks("step0#1", "step4#1", "step4#2")]);
  const env = { HERMES_VERSION: "0.22.5" };
  const calls = (r) => r.sb.hermesCalls().map((c) => c.join(" "));

  it("passes on the pinned commit, a 0.22.5 banner and a healthy pm; every native call is bound to -p default", async () => {
    await scenario({ name: "inst-v4", seed, script: gate, env, setup: (sb) => installedHost(sb) }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.ok(calls(r).includes("pm doctor"), calls(r).join(" | "));
      assert.ok(calls(r).includes("pm status"));
      assert.ok(!r.sb.log("hermes-profile.log").includes("unbound"));
      assertStateIdentical(r);
    });
  });

  for (const banner of ["Hermes Agent v0.21.6 (2026.9.1)", "hermes 0.15.2", "Hermes Agent v0.22.50", "Hermes Agent v10.22.5"]) {
    it(`a ${JSON.stringify(banner)} banner fails the gate`, async () => {
      await scenario({ name: "inst-v4-bad", seed, script: gate, env, setup: (sb) => installedHost(sb, banner) }, async (r) => {
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, /FAIL: version\/runtime not confirmed/);
        assert.ok(!calls(r).includes("pm doctor"), "pm is not consulted after a wrong version");
      });
    });
  }

  it("a checkout that is not at the pinned commit fails the gate", async () => {
    await scenario({ name: "inst-v4-commit", seed, script: gate, env, setup: (sb) => { installedHost(sb); sb.write("remote_bin/git", `#!/bin/bash\ncase "$*" in *rev-parse*) echo ${"0".repeat(40)} ;; *) exit 0 ;; esac\n`, 0o755); } }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /FAIL: version\/runtime not confirmed/);
    });
  });

  it("pm doctor failing (a required package is missing) fails the gate", async () => {
    await scenario({ name: "inst-v4-pm", seed, script: gate, env, knobs: { "fail.pm.doctor": true }, setup: (sb) => installedHost(sb) }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /FAIL: version\/runtime not confirmed/);
    });
  });

  it("hermes doctor exiting non-zero (issues remain) is REPORTED, not fatal, and does not stop the install handoff", async () => {
    await scenario({ name: "inst-doctor", seed, script: all, env, knobs: { doctor_issues: "Run 'hermes setup' to configure API keys\n" }, setup: (sb) => installedHost(sb) }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /NOTE: hermes -p default doctor exited 1/);
      assert.match(r.out, /Run 'hermes setup' to configure API keys/);
      assert.doesNotMatch(r.out, /FAIL/);
      assert.ok(calls(r).includes("doctor"));
    });
  });

  it("hermes doctor with nothing left to fix says so", async () => {
    await scenario({ name: "inst-doctor-ok", seed, script: all, env, setup: (sb) => installedHost(sb) }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /OK: hermes -p default doctor reports no remaining issues/);
    });
  });

  it("a crashing doctor (not 'issues remain') is also reported with its exit code and does not abort", async () => {
    await scenario({ name: "inst-doctor-crash", seed, script: all, env, knobs: { "fail.doctor": true }, setup: (sb) => installedHost(sb) }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /NOTE: hermes -p default doctor exited 1/);
    });
  });
});

describe("hermes-install: text invariants", () => {
  const text = readFileSync(path.join(REPO_ROOT, "skills/hermes-install/SKILL.md"), "utf8");
  const code = loadBlocks(SKILL).map((b) => b.code).join("\n");

  it("no candidate framing, no opt-in variable, no mutable-main installer, no pip", () => {
    assert.doesNotMatch(text, /CANDIDATE_ACKNOWLEDGED|compatibility candidate|opt-in|unpromoted/i);
    assert.doesNotMatch(code, /pip install|\/main\/scripts\/install|CANDIDATE/);
    assert.match(text, /source-verified/i);
    assert.match(text, /## Verified against Hermes v0\.22\.5/);
  });

  it("pins the commit and installer digest from VERSIONS.txt", () => {
    const versions = readFileSync(path.join(REPO_ROOT, "VERSIONS.txt"), "utf8");
    assert.ok(text.includes(/^HERMES_COMMIT=(\w+)$/m.exec(versions)[1]));
    assert.ok(text.includes(/^HERMES_INSTALLER_SHA256=(\w+)$/m.exec(versions)[1]));
    assert.ok(versions.includes(`HERMES_INSTALLER_URL=https://raw.githubusercontent.com/NousResearch/hermes-agent/${COMMIT}/scripts/install.sh`));
  });

  it("the only parse-skipped lines are the two pm lines, each with the dispatch reason", () => {
    const skipped = loadBlocks(SKILL).flatMap((b) => b.code.split("\n")).filter((l) => l.includes("hermes-parse: skip"));
    assert.equal(skipped.length, 2, skipped.join("\n"));
    for (const l of skipped) assert.match(l, /^hermes -p default pm (doctor|status) +# hermes-parse: skip \(pm is dispatched before argparse: hermes_cli\/main\.py:679-683\)$/);
  });

  it("documents that hermes doctor exits non-zero while issues remain and that this is not a gate", () => {
    assert.match(text, /exits non-zero\s+whenever any issue remains/);
    assert.match(text, /hermes_cli\/doctor\.py:171-194/);
    assert.match(text, /is not verified/);
  });
});
