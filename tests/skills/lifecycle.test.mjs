// The shared gateway lifecycle helpers (gw_ready / gw_reload) from the Step 0 block of the skill template, run against the
// stub whose syntax layer is the real v0.22.5 argparse. Behaviour of the stub is an assumption; the call shapes are not.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assemble, TEMPLATE_PATH } from "./helpers/blocks.mjs";
import { scenario } from "./helpers/sandbox.mjs";

const step0 = { skill: TEMPLATE_PATH, ids: ["step0#1"], placeholders: { "skill-name": "fixture" } };
const run = (body, opts = {}) => scenario({ name: "lifecycle", script: assemble(["set +e\n", step0, body, "echo SCRIPT-COMPLETED\n"]), ...opts }, opts.check);
const gwCalls = (r) => r.sb.hermesCalls().filter((c) => c[0] === "-p" ? c[2] === "gateway" : c[0] === "gateway").map((c) => (c[0] === "-p" ? c.slice(2) : c).join(" "));

describe("gw_reload / gw_ready", () => {
  it("reload = restart --detach, then ensure --json until ready with a NEW instance", async () => {
    await run('gw_reload; echo "RC=$?"\n', {
      check: async (r) => {
        assert.match(r.out, /RC=0/);
        assert.match(r.out, /"state":"ready"/);
        const calls = gwCalls(r);
        assert.ok(calls.includes("gateway restart --detach"), calls.join("\n"));
        assert.ok(calls.some((c) => c === "gateway ensure --json --timeout 60"));
        assert.ok(calls.indexOf("gateway restart --detach") < calls.lastIndexOf("gateway ensure --json --timeout 60"));
        assert.ok(!calls.some((c) => /\bstop\b|\brun\b|--daemon|status/.test(c)), "never stop/run/status: " + calls.join("; "));
        assert.ok(!calls.some((c) => / -y\b| --yes\b|--force|--all/.test(c)), "no interruption flags by default");
      },
    });
  });

  for (const interrupt of [undefined, "", "0", "false", "1"]) {
    it(`live sessions: GW_INTERRUPT=${JSON.stringify(interrupt)} only interrupts when literally 1`, async () => {
      await run('gw_reload; echo "RC=$?"\n', {
        env: { GW_INTERRUPT: interrupt },
        knobs: { live_sessions: true },
        check: async (r) => {
          const allowed = interrupt === "1";
          assert.match(r.out, allowed ? /RC=0/ : /RC=1/);
          if (!allowed) assert.match(r.out, /refused|live session/i);
          assert.equal(gwCalls(r).includes("gateway restart --detach -y"), allowed);
        },
      });
    });
  }

  for (const pipefail of [false, true]) {
    it(`a draining pre-probe (exit 6) retains endpoint identity with pipefail=${pipefail}, so a no-op restart fails`, async () => {
      // Native gateway_runtime preserves an endpoint for draining/restart_wait; gateway_runtime_cli maps it to exit 6.
      // Inject only that source-backed pre-probe; readiness and restart keep using the existing offline model.
      const script = assemble([
        `set +e\n${pipefail ? "set -o pipefail\n" : ""}`,
        { ...step0, replace: [["remote() {", "native_remote() {"]] },
        `remote() {
  case "$*" in
    *'gateway ensure --json --timeout 10'*)
      printf '%s\\n' '{"client_code_sha":"stub","endpoint":{"instance_id":"inst-41"},"reason_code":"restart_wait","state":"draining"}'
      return 6 ;;
    *) native_remote "$@" ;;
  esac
}
gw_reload; echo "RC=$?"
  `,
      ]);
      await scenario({ name: "draining-identity", script, knobs: { restart_noop: true }, files: { ".hermes/gateway.state": "running\n", ".hermes/gateway.instance": "41\n" } }, async r => {
        assert.match(r.out, /RC=1/);
        assert.match(r.out, /instance did not change/);
        assert.ok(gwCalls(r).includes("gateway restart --detach"));
      });
    });
  }

  it("a restart that did nothing (same instance_id) is a failure, not a success", async () => {
    await run('gw_reload; echo "RC=$?"\n', {
      knobs: { restart_noop: true },
      check: async (r) => {
        assert.match(r.out, /RC=1/);
        assert.match(r.out, /instance did not change/);
      },
    });
  });

  it("restart failing outright is a failure and ensure is not consulted afterwards", async () => {
    await run('gw_reload; echo "RC=$?"\n', {
      knobs: { "fail.gateway.restart": true },
      check: async (r) => {
        assert.match(r.out, /RC=1/);
        const calls = gwCalls(r);
        assert.equal(calls.filter((c) => c.startsWith("gateway ensure")).length, 1, "only the pre-restart probe");
      },
    });
  });

  for (const [code, label] of [[5, "deadline"], [6, "draining"], [3, "incompatible"], [7, "conflict"]]) {
    it(`gw_ready: ensure exit ${code} (${label}) is never ready${code === 5 || code === 6 ? " (retried twice first)" : ""}`, async () => {
      await run('gw_ready; echo "RC=$?"\n', {
        knobs: { ensure_exit: String(code) },
        check: async (r) => {
          assert.match(r.out, /RC=1/);
          assert.doesNotMatch(r.out, /"state":"ready"/);
          const n = gwCalls(r).filter((c) => c.startsWith("gateway ensure")).length;
          assert.equal(n, code === 5 || code === 6 ? 3 : 1);
        },
      });
    });
  }

  it("gw_ready does not trust status text: a status line saying running is irrelevant", async () => {
    await run('gw_ready; echo "RC=$?"\n', {
      knobs: { ensure_exit: "5", status_override: "gateway running\n" },
      check: async (r) => {
        assert.match(r.out, /RC=1/);
        assert.ok(!gwCalls(r).some((c) => c.includes("status")));
      },
    });
  });
});

describe("stub fidelity (the thing that hid `gateway run --daemon`)", () => {
  it("the stub rejects the nonexistent flag and the retired mcp flags exactly like argparse (exit 2)", async () => {
    await run('remote "hermes -p default gateway run --daemon"; echo "A=$?"; remote "hermes -p default mcp add x --auth-header Authorization"; echo "B=$?"; remote "hermes -p default gateway restart"; echo "C=$?"\n', {
      check: async (r) => {
        assert.match(r.out, /A=2/);
        assert.match(r.out, /B=2/);
        assert.match(r.out, /unrecognized arguments: --daemon/);
        assert.match(r.out, /C=99/, "restart without --detach and without a service would block in the foreground");
      },
    });
  });
});

describe("the simulated VPS cannot signal real processes", () => {
  it("pkill / killall / pgrep on the VPS are logged and refused (a control that runs `pkill -f hermes` once killed the test runner)", async () => {
    await run('remote "pkill -f hermes"; echo "A=$?"; remote "killall node"; echo "B=$?"; remote "pgrep -f hermes"; echo "C=$?"\n', {
      check: async (r) => {
        assert.match(r.out, /A=99/);
        assert.match(r.out, /B=99/);
        assert.match(r.out, /C=99/);
        assert.match(r.sb.log("local-forbidden.log"), /pkill called: -f hermes/);
      },
    });
  });
});
