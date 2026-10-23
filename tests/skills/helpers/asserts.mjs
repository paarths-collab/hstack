// Assertions shared by the skill block tests. Each takes the result object handed out by scenario().
import assert from "node:assert/strict";

/** Events that change the VPS (reads like `--version`, `mcp list`, `config show`, `logs` are excluded). */
export const WRITE_EVENT = /^hermes (config set|mcp add|mcp remove|gateway (stop|run|start|install|ensure)|setup|cron (create|remove))/;

export const writeEvents = (run) => run.sb.events().filter((e) => WRITE_EVENT.test(e));
export const curlEvents = (run) => run.sb.events().filter((e) => e.startsWith("curl"));

/** Nothing the skill may change differs from before the run (bytes, absence and file mode). */
export function assertStateIdentical(run, what = "state") {
  assert.deepEqual(run.after, run.before, `${what}: .env/config.yaml/SOUL.md/crontab changed`);
}
export function assertStateChanged(run) {
  assert.notDeepEqual(run.after, run.before, "expected the run to change state (otherwise 'unchanged' proves nothing)");
}

/** No secret appears in any ssh command string or curl argument, and the local machine ran no curl/wget. */
export function assertNoSecretInArgv(run, secrets) {
  const ssh = run.sb.sshCalls();
  const curl = run.sb.curlCalls();
  assert.ok(ssh.length > 0, "no ssh calls were recorded: the argv check would be vacuous");
  for (const s of secrets) {
    assert.ok(s && s.length > 8, "secret under test must be a real string");
    ssh.forEach((c, i) => assert.ok(!c.includes(s), `a secret appears in ssh call #${i + 1}`));
    curl.forEach((c, i) => assert.ok(!c.argv.includes(s), `a secret appears in curl argv of call #${i + 1}`));
  }
  curl.forEach((c, i) => assert.equal(c.argv_has_token, "0", `curl call #${i + 1} had the token in argv`));
  assert.equal(run.sb.log("local-forbidden.log"), "", "the local machine ran curl/wget");
}
export function assertSecretsNotPrinted(run, secrets) {
  for (const s of secrets) assert.ok(!run.out.includes(s), "a secret was printed in the script output");
}
export const idx = (events, re, from = 0) => {
  for (let i = from; i < events.length; i++) if (re.test(events[i])) return i;
  return -1;
};
