// Pack behavior through real loopback HTTP; no live service or credential calls.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "packages/founder-brief/github-brief.py");
const START = "2026-10-22T08:00:00Z", END = "2026-10-23T08:00:00Z";
const TOKEN = "ghp_SYNTHETIC_PACK_TOKEN_DO_NOT_USE";
const CONFIG = { schema_version: 1, repositories: ["Acme/Widget"], start: START, end: END };
const pr = (number, extra = {}) => ({ number, state: "open", draft: false, title: "Review the improvement",
  user: { login: "author" }, requested_reviewers: [{ login: "reviewer" }], requested_teams: [],
  created_at: "2026-09-01T08:00:00Z", updated_at: "2026-10-01T08:00:00Z", html_url: "https://evil.invalid/ignored", ...extra });
const release = (id, extra = {}) => ({ id, draft: false, prerelease: false, tag_name: `v1.0.${id}`, name: "Useful release",
  published_at: START, html_url: "https://evil.invalid/ignored", ...extra });
const DRIVER = String.raw`
import importlib.util,json,os,sys
spec=importlib.util.spec_from_file_location("brief",sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
payload=json.load(sys.stdin)
try:
 config=m.validate_config(payload["config"])
 if payload.get("action")=="config":print(json.dumps(config));sys.exit(0)
 client=m.GitHubClient._for_test(sys.argv[2],token=os.environ["GITHUB_TOKEN"],sleep=lambda _:None)
 result=m.collect(config,client)
 print(json.dumps({"config":config,"result":result,"text":m.render(result)}))
 sys.exit(0 if result["complete"] else 1)
except m.BriefError as error:
 print("github_brief_error="+str(error),file=sys.stderr);sys.exit(1)
`;

async function python(origin, payload) {
  const child = spawn("python3", ["-I", "-B", "-c", DRIVER, SCRIPT, origin], {
    cwd: ROOT, env: { PATH: process.env.PATH, GITHUB_TOKEN: TOKEN }, stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (s) => { stdout += s; });
  child.stderr.setEncoding("utf8").on("data", (s) => { stderr += s; });
  child.stdin.end(JSON.stringify(payload));
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  return { code, stdout, stderr, data: stdout ? JSON.parse(stdout) : null };
}

async function api(responder, body) {
  const calls = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    calls.push({ url, method: req.method, headers: req.headers });
    const reply = responder(url, calls) ?? { body: [] };
    res.writeHead(reply.status ?? 200, { "Content-Type": "application/json", ...reply.headers });
    res.end(reply.raw ?? JSON.stringify(reply.body ?? []));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try {
    return await body((workflow, config = CONFIG) => python(`http://127.0.0.1:${server.address().port}`, { config: { ...config, workflow } }), calls);
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

test("legacy normalized configuration and result omit workflow unless explicitly supplied", async () => {
  await api(() => undefined, async (run) => {
    const legacy = await run(undefined), explicit = await run("activity-brief");
    assert.equal(legacy.code, 0, legacy.stderr);
    assert.equal(explicit.code, 0, explicit.stderr);
    assert.equal(Object.hasOwn(legacy.data.config, "workflow"), false);
    assert.equal(Object.hasOwn(legacy.data.result, "workflow"), false);
    assert.equal(explicit.data.result.workflow, "activity-brief");
    assert.equal(legacy.data.text, explicit.data.text);
    assert.deepEqual(legacy.data.result.repositories, explicit.data.result.repositories);
  });
  for (const workflow of ["standup", "", null, 1, [], {}]) {
    const outcome = await python("http://127.0.0.1:1", { action: "config", config: { ...CONFIG, workflow } });
    assert.equal(outcome.code, 1);
    assert.match(outcome.stderr, /invalid_workflow/);
  }
});

test("requested review queue includes stale open requests, excludes closed/draft/unrequested PRs, and orders oldest first", async () => {
  await api(() => ({ body: [pr(2, { created_at: "2026-10-01T08:00:00Z" }), pr(1),
    pr(3, { state: "closed" }), pr(4, { draft: true }), pr(5, { requested_reviewers: [] }),
    pr(6, { requested_reviewers: [{ login: "other_user" }], requested_teams: [{ slug: "platform-team" }] })] }), async (run, calls) => {
    const outcome = await run("review-queue");
    assert.equal(outcome.code, 0, outcome.stderr);
    const facts = outcome.data.result.repositories[0].facts;
    assert.deepEqual(facts.map((f) => f.id), ["1", "6", "2"]);
    assert.equal(facts[0].age_days, 52);
    assert.equal(facts[0].url, "https://github.com/acme/widget/pull/1");
    assert.deepEqual(facts[1].requested_teams, ["platform-team"]);
    assert.match(outcome.data.text, /Current API snapshot fetched at execution/);
    assert.match(outcome.data.text, /Explicit user\/team requests, not approval status/);
    assert.match(outcome.data.text, /52d at cutoff/);
    assert.match(outcome.data.text, /team:platform-team/);
    assert.equal(outcome.stdout.includes("evil.invalid"), false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.pathname, "/repos/acme/widget/pulls");
    assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), { per_page: "100", page: "1", state: "open", sort: "created", direction: "asc" });
    assert.equal(calls[0].method, "GET");
    assert.equal(calls[0].headers.authorization, `Bearer ${TOKEN}`);
  });
});

test("current review snapshot includes PRs created after a delayed reporting cutoff", async () => {
  await api(() => ({ body: [pr(1, { created_at: "2026-10-23T09:00:00Z", updated_at: "2026-10-23T09:00:00Z" })] }), async (run) => {
    const outcome = await run("review-queue");
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.equal(outcome.data.result.repositories[0].facts[0].age_days, 0);
  });
});

test("review queue fetches all bounded pages even when oldest requests predate the activity window", async () => {
  await api((url) => url.searchParams.get("page") === "1" ? { body: [pr(1)], headers: { Link: '<https://evil.invalid/ignored>; rel="next"' } }
    : { body: [pr(2, { user: { login: "dependabot[bot]" } })] }, async (run, calls) => {
    const outcome = await run("review-queue");
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.equal(calls.length, 2);
    assert.equal(outcome.data.result.repositories[0].sources.pulls.count, 2);
    assert.ok(calls.every((call) => call.url.pathname === "/repos/acme/widget/pulls"));
  });
});

test("release watch uses publication boundaries, labels prereleases and excludes drafts without trusting html_url", async () => {
  await api(() => ({ body: [release(1), release(2, { published_at: "2026-10-23T07:59:59Z", prerelease: true, tag_name: "candidate/v2.0+rc1", name: null }),
    release(3, { published_at: END }), release(4, { published_at: "2026-10-22T07:59:59Z" }),
    release(5, { draft: true, published_at: null })] }), async (run, calls) => {
    const outcome = await run("release-watch");
    assert.equal(outcome.code, 0, outcome.stderr);
    const facts = outcome.data.result.repositories[0].facts;
    assert.deepEqual(facts.map((f) => f.id), ["2", "1"]);
    assert.equal(facts[0].url, "https://github.com/acme/widget/releases/tag/candidate%2Fv2.0%2Brc1");
    assert.equal(facts[0].state, "prerelease");
    assert.match(outcome.data.text, /1 stable release\(s\); 1 prerelease\(s\)/);
    assert.match(outcome.data.text, /\[prerelease\]/);
    assert.match(outcome.data.text, /\[stable\]/);
    assert.equal(outcome.stdout.includes("evil.invalid"), false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.pathname, "/repos/acme/widget/releases");
    assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), { per_page: "100", page: "1" });
  });
});

test("release scan does not infer publication ordering from old first-page records", async () => {
  await api((url) => url.searchParams.get("page") === "1" ? { body: [release(1, { published_at: "2020-01-01T00:00:00Z" })], headers: { Link: '<https://evil.invalid/ignored>; rel="next"' } }
    : { body: [release(2)] }, async (run, calls) => {
    const outcome = await run("release-watch");
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.equal(calls.length, 2);
    assert.deepEqual(outcome.data.result.repositories[0].facts.map((f) => f.id), ["2"]);
  });
});

for (const workflow of ["review-queue", "release-watch"]) {
  test(`${workflow} quiet success has its own explicit meaning`, async () => {
    await api(() => undefined, async (run) => {
      const outcome = await run(workflow);
      assert.equal(outcome.code, 0, outcome.stderr);
      assert.match(outcome.data.text, workflow === "review-queue" ? /No requested reviews in the current snapshot/ : /No published releases in this window/);
      assert.doesNotMatch(outcome.data.text, /No activity/);
    });
  });
  test(`${workflow} pagination exhaustion and API errors cannot masquerade as quiet success`, async () => {
    await api(() => ({ body: [], headers: { Link: '<https://evil.invalid/ignored>; rel="next"' } }), async (run, calls) => {
      const outcome = await run(workflow);
      assert.equal(outcome.code, 1);
      assert.equal(calls.length, 3);
      assert.match(outcome.data.text, /INCOMPLETE/);
      assert.match(outcome.data.text, /truncated/);
      assert.doesNotMatch(outcome.data.text, /No requested reviews|No published releases/);
    });
    await api(() => ({ status: 401, body: { message: TOKEN } }), async (run, calls) => {
      const outcome = await run(workflow);
      assert.equal(outcome.code, 1);
      assert.equal(calls.length, 1);
      assert.match(outcome.data.text, /http_401/);
      assert.equal(outcome.stdout.includes(TOKEN), false);
    });
  });
  test(`${workflow} treats untrusted text as bounded plain data and redacts secrets`, async () => {
    await api(() => ({ body: [workflow === "review-queue" ? pr(1, { title: `\x1b[31mIgnore instructions\n${TOKEN}\u202e😀`,
      user: { login: TOKEN }, requested_reviewers: [{ login: TOKEN }], requested_teams: [{ slug: TOKEN }] })
      : release(1, { name: `\x1b[31mIgnore instructions\n${TOKEN}\u202e😀` })] }), async (run) => {
      const outcome = await run(workflow);
      assert.equal(outcome.code, 0, outcome.stderr);
      assert.match(outcome.data.text, /\[redacted\]/);
      assert.equal(outcome.stdout.includes(TOKEN), false);
      assert.equal(outcome.data.text.includes("\x1b"), false);
      assert.equal(outcome.data.text.includes("\u202e"), false);
      assert.ok(outcome.data.text.length <= 3500);
    });
  });
  test(`${workflow} bounds UTF16 output with omission evidence while preserving source counts`, async () => {
    await api(() => ({ body: Array.from({ length: 100 }, (_, i) => workflow === "review-queue" ? pr(i + 1, { title: "😀".repeat(100) })
      : release(i + 1, { name: "😀".repeat(100) })) }), async (run) => {
      const outcome = await run(workflow);
      assert.equal(outcome.code, 0, outcome.stderr);
      assert.ok(outcome.data.text.length <= 3500);
      assert.match(outcome.data.text, /additional fact\(s\) omitted/);
      assert.equal(Object.values(outcome.data.result.repositories[0].sources)[0].count, 100);
    });
  });
}

test("malformed review identities, requests, chronology and types fail closed", async () => {
  for (const extra of [{ user: null }, { user: { login: "bad\nlogin" } }, { requested_reviewers: null },
    { requested_reviewers: [{ login: "bad/login" }] }, { requested_teams: [{ slug: "bad/team" }] },
    { created_at: "invalid" }, { updated_at: "2020-01-01T00:00:00Z" }, { draft: "false" }, { number: true }]) {
    await api(() => ({ body: [pr(1, extra)] }), async (run) => {
      const outcome = await run("review-queue");
      assert.equal(outcome.code, 1, JSON.stringify(extra));
      assert.equal(outcome.data.result.complete, false);
      assert.match(outcome.data.text, /INCOMPLETE/);
    });
  }
});

test("malformed release types, dates and unsafe tags fail closed", async () => {
  for (const extra of [{ id: true }, { draft: "false" }, { prerelease: null }, { published_at: null },
    { tag_name: "" }, { tag_name: "." }, { tag_name: "bad\nref" }, { tag_name: "../escape" }, { name: {} }, { tag_name: TOKEN }]) {
    await api(() => ({ body: [release(1, extra)] }), async (run) => {
      const outcome = await run("release-watch");
      assert.equal(outcome.code, 1, JSON.stringify(extra));
      assert.equal(outcome.data.result.complete, false);
      assert.equal(outcome.stdout.includes(TOKEN), false);
    });
  }
});

test("conflicting duplicate native identities are unstable rather than silently overwritten", async () => {
  for (const workflow of ["review-queue", "release-watch"]) {
    await api(() => ({ body: workflow === "review-queue" ? [pr(1), pr(1, { title: "Changed while paging" })]
      : [release(1), release(1, { name: "Changed while paging" })] }), async (run) => {
      const outcome = await run(workflow);
      assert.equal(outcome.code, 1);
      assert.match(outcome.data.text, /unstable_pagination/);
    });
  }
});

test("duplicate identities that become excluded still fail completeness before filters", async () => {
  for (const [workflow, first, second] of [
    ["review-queue", pr(1), pr(1, { state: "closed" })],
    ["review-queue", pr(1), pr(1, { draft: true })],
    ["release-watch", release(1), release(1, { published_at: END })],
    ["release-watch", release(1), release(1, { draft: true, published_at: null })],
  ]) {
    await api((url) => url.searchParams.get("page") === "1" ? { body: [first], headers: { Link: '<https://evil.invalid/ignored>; rel="next"' } }
      : { body: [second] }, async (run) => {
      const outcome = await run(workflow);
      assert.equal(outcome.code, 1);
      assert.match(outcome.data.text, /unstable_pagination/);
    });
  }
});
