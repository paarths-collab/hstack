// platform-google-chat: the real SKILL.md blocks against a simulated VPS (helpers/sandbox.mjs).
//
// Real here: the bash of the skill, the argparse syntax of every `hermes` call (vendored v0.22.5 builders), the ssh/stdin plumbing, and the
// service-account JWT the skill builds on the "VPS" (the curl stub verifies its claims and its RS256 signature with a locally generated key).
// Assumed: how the stubbed Hermes, curl, Google token endpoint and Pub/Sub BEHAVE (each stub says so in its header).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { assertNoSecretInArgv, assertSecretsNotPrinted, assertStateIdentical, idx, writeEvents } from "./helpers/asserts.mjs";
import { assemble, loadBlocks, skillPath } from "./helpers/blocks.mjs";
import { SCRIPT_END, scenario } from "./helpers/sandbox.mjs";

const SKILL = "platform-google-chat";
const PROJECT = "my-proj-123";
const SUB = `projects/${PROJECT}/subscriptions/hermes-chat-events-sub`;
const EMAIL = `hermes-bot@${PROJECT}.iam.gserviceaccount.com`;
const OTHER_EMAIL = `other-bot@${PROJECT}.iam.gserviceaccount.com`;

// ---- throw-away RSA keys and service-account JSON files (generated now, never committed) ----
const tmp = mkdtempSync(path.join(os.tmpdir(), "hstack-gchat-keys-"));
const sh = (args) => {
  const r = spawnSync("openssl", args, { encoding: "utf8" });
  assert.equal(r.status, 0, `openssl ${args.join(" ")}: ${r.stderr}`);
};
const genKey = (name) => {
  const raw = path.join(tmp, `${name}.raw.pem`), pk8 = path.join(tmp, `${name}.pk8.pem`), pub = path.join(tmp, `${name}.pub.pem`), pk1 = path.join(tmp, `${name}.pk1.pem`);
  sh(["genrsa", "-out", raw, "2048"]);
  sh(["pkcs8", "-topk8", "-nocrypt", "-in", raw, "-out", pk8]); // what Google's key files carry: BEGIN PRIVATE KEY
  sh(["rsa", "-in", pk8, "-pubout", "-out", pub]);
  let traditional = null;
  if (spawnSync("openssl", ["rsa", "-in", pk8, "-traditional", "-out", pk1], { encoding: "utf8" }).status === 0) traditional = readFileSync(pk1, "utf8");
  return { pem: readFileSync(pk8, "utf8"), pub: readFileSync(pub, "utf8"), traditional };
};
const KEY1 = genKey("one");
const KEY2 = genKey("two");
const saJson = (pem, over = {}, pretty = true) => {
  const o = { type: "service_account", project_id: PROJECT, private_key_id: "0123456789abcdef", private_key: pem, client_email: EMAIL, client_id: "1234567890123", auth_uri: "https://accounts.google.com/o/oauth2/auth", token_uri: "https://oauth2.googleapis.com/token", ...over };
  return pretty ? JSON.stringify(o, null, 2) + "\n" : JSON.stringify(o);
};
let fileN = 0;
const keyFile = (text) => {
  const p = path.join(tmp, `sa-${++fileN}.json`);
  writeFileSync(p, text);
  return p;
};
const GOOD_JSON = saJson(KEY1.pem);
const GOOD_FILE = keyFile(GOOD_JSON);
const sum = (text) => spawnSync("cksum", { input: text, encoding: "utf8" }).stdout.split(" ")[0];
const saPath = (text) => `.hermes/google-chat-sa-${sum(text)}.json`;
// a distinctive slice of the key body: it must never appear anywhere except the file on the VPS
const keySlice = (pem) => pem.split("\n")[2].slice(0, 40);
const SECRETS = (json, pem) => [json, keySlice(pem)];

const GOOD_LOGS =
  "2026-01-01 INFO gateway.run: Connecting to google_chat...\n" +
  `2026-01-01 INFO gateway.platforms.google_chat: [GoogleChat] Connected; project=${PROJECT}, inbound=pubsub, subscription=<redacted>, bot_user_id=<unresolved>, flow_control(msgs=1, bytes=16777216)\n` +
  "2026-01-01 INFO gateway.run: ✓ google_chat connected\n";

const FLOW = ["step1#1", "step2#1", "step3#1", "step3#2", "step3#3", "step4#1", "step5#1", "step5#2", "step6#1", "step7#1", "step7#2", "step8#1"];
const flow = ({ ids = FLOW, replace = [] } = {}) =>
  assemble(["set +e\n", { skill: SKILL, ids: ["before-you-start#1", "step0#1"] }, { skill: SKILL, ids, replace }, SCRIPT_END]);
const localGate = () => assemble(["set +e\n", { skill: SKILL, ids: ["step0#1", "step3#1"] }, SCRIPT_END]);

const env = (over = {}) => ({
  GOOGLE_CHAT_PROJECT_ID: PROJECT, GOOGLE_CHAT_SUBSCRIPTION_NAME: SUB, SA_KEY_LOCAL_PATH: GOOD_FILE, GOOGLE_CHAT_ALLOWED_USERS: "alice@example.com", ...over,
});
const knobs = (over = {}) => ({ jwt_pubkey: KEY1.pub, ...over });
const oldState = (home) => ({
  env: `FOO=bar\nGOOGLE_CHAT_PROJECT_ID=old-proj\nGOOGLE_CHAT_SUBSCRIPTION_NAME=projects/old-proj/subscriptions/old-sub\nGOOGLE_CHAT_SERVICE_ACCOUNT_JSON=${home}/.hermes/google-chat-sa-old.json\nGOOGLE_CHAT_ALLOWED_USERS=bob@example.com\nOTHER_KEY=keep-me\n`,
  config: "model.default: old/model\n",
});
const setKeys = (run) => run.sb.events().filter((e) => e.startsWith("hermes config set ")).map((e) => e.slice("hermes config set ".length));
const run1 = (opts, check) =>
  scenario({ valid: [EMAIL], files: { "logs.txt": GOOD_LOGS }, script: flow(), env: env(), ...opts, knobs: knobs(opts.knobs) }, check);
/** Seed an already-wired VPS (old key file referenced from .env, mode 600) inside a sandbox. */
const withOld = (extra = {}) => ({
  setup: (sb) => {
    sb.write(".hermes/.env", oldState(sb.home).env, 0o600);
    sb.write(".hermes/config.yaml", oldState(sb.home).config, 0o644);
    sb.write(".hermes/google-chat-sa-old.json", saJson(KEY2.pem, { client_email: OTHER_EMAIL }), 0o600);
    extra.setup?.(sb);
  },
});
const sandboxOldEnv = (run) => run.sb.read(".hermes/.env");

describe("platform-google-chat: good run", { concurrency: 4 }, () => {
  it("Google token + subscription read first (real key, signed JWT), then key upload and writes, native reload, read-back proof, finish", async () => {
    await run1({ name: "gc-good" }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.ok(run.completed);
      const calls = run.sb.curlCalls();
      // 1-2: preflight (token, subscription), 3-4: the same through the key file stored on the VPS
      assert.deepEqual(calls.map((c) => c.url), [
        "https://oauth2.googleapis.com/token", `https://pubsub.googleapis.com/v1/${SUB}`,
        "https://oauth2.googleapis.com/token", `https://pubsub.googleapis.com/v1/${SUB}`,
      ]);
      assert.deepEqual(calls.map((c) => c.status), ["200", "200", "200", "200"], "the JWT verified against the matching public key, so its claims and RS256 signature are right");
      assert.match(run.sb.log("curl.log"), /form=grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=<JWT>/);
      for (const c of calls) assert.equal(c.argv_has_token, "0");

      const ev = run.sb.events();
      assert.ok(idx(ev, /^curl status=200/) >= 0 && idx(ev, /^curl status=200/) < idx(ev, /^hermes config set/), "the Google check must happen before the first write");
      assert.deepEqual(setKeys(run), ["GOOGLE_CHAT_ALLOWED_USERS", "GOOGLE_CHAT_SERVICE_ACCOUNT_JSON", "GOOGLE_CHAT_PROJECT_ID", "GOOGLE_CHAT_SUBSCRIPTION_NAME"]);
      const rel = saPath(GOOD_JSON);
      assert.equal(run.sb.read(rel), GOOD_JSON, "the key file on the VPS is byte-identical to the local one");
      assert.equal(run.sb.mode(rel), 0o600);
      const text = run.sb.read(".hermes/.env");
      assert.match(text, new RegExp(`^GOOGLE_CHAT_SERVICE_ACCOUNT_JSON=${run.sb.home}/${rel}$`, "m"));
      assert.match(text, /^GOOGLE_CHAT_ALLOWED_USERS=alice@example\.com$/m);
      assert.match(text, new RegExp(`^GOOGLE_CHAT_SUBSCRIPTION_NAME=${SUB}$`, "m"));
      assert.ok(!/ENABLED|ALLOW_ALL|BEGIN PRIVATE/.test(text), "no switch of any kind, and no key material, in .env");
      assert.equal(run.sb.mode(".hermes/.env"), 0o600);
      const cfg = run.sb.read(".hermes/config.yaml");
      assert.ok(!cfg || (!cfg.includes(keySlice(KEY1.pem)) && !/google_chat/.test(cfg)));
      const gw = run.sb.events().filter((e) => /^hermes gateway /.test(e));
      assert.deepEqual(gw.filter((e) => e !== "hermes gateway ensure"), ["hermes gateway restart"]);
      assert.ok(run.sb.hermesCalls().some((c) => c.join(" ") === "gateway restart --detach"));
      assert.ok(run.sb.exists(".hermes/.hstack-backup/platform-google-chat.prev"));
      assert.ok(!run.sb.exists(".hermes/.hstack-backup/platform-google-chat"));
      assert.match(run.out, /Google accepted the service-account key and the subscription is readable/);
      assert.match(run.out, /gateway log reports Google Chat connected/);
      assert.match(run.out, /the stored key file still reads the subscription/);
      assertNoSecretInArgv(run, SECRETS(GOOD_JSON, KEY1.pem));
      assertSecretsNotPrinted(run, SECRETS(GOOD_JSON, KEY1.pem));
      // the key never reaches a hermes process at all (only its path does)
      const hermesLog = run.sb.log("hermes-argv.log");
      for (const s of SECRETS(GOOD_JSON, KEY1.pem)) assert.ok(!hermesLog.includes(s));
      assert.deepEqual(readdirKeyFiles(run), [rel.replace(".hermes/", "")]);
    });
  });

  it("every hermes call is bound to the default profile", async () => {
    await run1({ name: "gc-profile" }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.ok(run.sb.log("hermes-profile.log").split("\n").filter(Boolean).every((l) => l === "default"));
    });
  });

  it("a minified key file and a traditional (BEGIN RSA PRIVATE KEY) key both sign correctly", async () => {
    const min = saJson(KEY1.pem, {}, false);
    await run1({ name: "gc-min", env: env({ SA_KEY_LOCAL_PATH: keyFile(min) }) }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.equal(run.sb.read(saPath(min)), min);
    });
    if (KEY1.traditional) {
      const trad = saJson(KEY1.traditional);
      await run1({ name: "gc-trad", env: env({ SA_KEY_LOCAL_PATH: keyFile(trad) }) }, async (run) => {
        assert.equal(run.code, 0, run.out);
      });
    }
  });

  it("optional home space: one native send; allowlist is lower-cased, de-blanked", async () => {
    await run1({ name: "gc-home", env: env({ GOOGLE_CHAT_HOME_CHANNEL: "spaces/AAAA-bbb_CC", GOOGLE_CHAT_ALLOWED_USERS: " Alice@Example.com , bob@example.com,, " }) }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.deepEqual(setKeys(run), ["GOOGLE_CHAT_ALLOWED_USERS", "GOOGLE_CHAT_HOME_CHANNEL", "GOOGLE_CHAT_SERVICE_ACCOUNT_JSON", "GOOGLE_CHAT_PROJECT_ID", "GOOGLE_CHAT_SUBSCRIPTION_NAME"]);
      assert.match(run.sb.read(".hermes/.env"), /^GOOGLE_CHAT_ALLOWED_USERS=alice@example\.com,bob@example\.com$/m);
      assert.match(run.sb.read(".hermes/.env"), /^GOOGLE_CHAT_HOME_CHANNEL=spaces\/AAAA-bbb_CC$/m);
      assert.ok(run.sb.events().includes("hermes send google_chat"), run.sb.events().join("\n"));
    });
  });

  it("already stored and safe: exits 0, configuration only; no vendor call, no write", async () => {
    await run1({ name: "gc-idem", ...withOld(), env: env() }, async (run) => {
      // the seeded state has the old key file at mode 600 and a valid, e-mail-only allowlist
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /already stored \(configuration only; this does not prove the bot is connected\)/);
      assert.ok(!run.completed);
      assert.equal(run.sb.curlCalls().length, 0);
      assert.deepEqual(writeEvents(run), []);
    });
  });

  it("stored settings whose key file is missing or not mode 600 are not 'already wired'", async () => {
    await run1({ name: "gc-idem-key", ...withOld({ setup: (sb) => sb.write(".hermes/google-chat-sa-old.json", "{}", 0o644) }), env: env() }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.ok(run.completed, "needs_setup: the skill proceeds and rewrites");
    });
  });

  for (const [label, lines, mode] of [
    ["wildcard in the stored allowlist", "GOOGLE_CHAT_ALLOWED_USERS=bob@example.com,*\n"],
    ["a non-e-mail in the stored allowlist", "GOOGLE_CHAT_ALLOWED_USERS=bob\n"],
    ["duplicate allowlist", "GOOGLE_CHAT_ALLOWED_USERS=bob@example.com\nGOOGLE_CHAT_ALLOWED_USERS=eve@example.com\n"],
    ["GOOGLE_CHAT_ALLOW_ALL_USERS", "GOOGLE_CHAT_ALLOWED_USERS=bob@example.com\nGOOGLE_CHAT_ALLOW_ALL_USERS=true\n"],
    ["exported GATEWAY_ALLOW_ALL_USERS", "GOOGLE_CHAT_ALLOWED_USERS=bob@example.com\nexport GATEWAY_ALLOW_ALL_USERS=1\n"],
    ["GATEWAY_ALLOWED_USERS=*", "GOOGLE_CHAT_ALLOWED_USERS=bob@example.com\nGATEWAY_ALLOWED_USERS=*\n"],
    ["world-readable .env", "GOOGLE_CHAT_ALLOWED_USERS=bob@example.com\n", 0o644],
  ]) {
    it(`stored setup with ${label}: aborts instead of reporting success`, async () => {
      const seed = { env: `GOOGLE_CHAT_PROJECT_ID=old-proj\nGOOGLE_CHAT_SUBSCRIPTION_NAME=projects/old-proj/subscriptions/old-sub\nGOOGLE_CHAT_SERVICE_ACCOUNT_JSON=/x/key.json\n${lines}`, envMode: mode ?? 0o600 };
      await run1({ name: "gc-unsafe", seed }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, /stored Google Chat setup is unsafe/);
        assert.ok(!run.out.includes("already stored"));
        assertStateIdentical(run);
        assert.deepEqual(writeEvents(run), []);
        assert.equal(run.sb.curlCalls().length, 0);
      });
    });
  }

  it("FORCE=1 with a NEW key writes a new key file and leaves the old one alone", async () => {
    const newJson = saJson(KEY2.pem, { client_email: OTHER_EMAIL });
    await run1({ name: "gc-force", ...withOld(), valid: [OTHER_EMAIL], knobs: { jwt_pubkey: KEY2.pub }, env: env({ FORCE: "1", SA_KEY_LOCAL_PATH: keyFile(newJson) }) }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.equal(run.sb.read(saPath(newJson)), newJson);
      assert.ok(run.sb.exists(".hermes/google-chat-sa-old.json"), "the previous key file is never touched");
      assert.match(run.sb.read(".hermes/.env"), new RegExp(`^GOOGLE_CHAT_SERVICE_ACCOUNT_JSON=${run.sb.home}/${saPath(newJson)}$`, "m"));
      assert.match(run.sb.read(".hermes/.env"), /^OTHER_KEY=keep-me$/m);
      assert.match(run.sb.read(".hermes/.hstack-backup/platform-google-chat.prev/.env"), /google-chat-sa-old\.json/);
    });
  });

  it("FORCE=1 with the SAME key reuses the existing file", async () => {
    await run1({ name: "gc-same", setup: (sb) => sb.write(saPath(GOOD_JSON), GOOD_JSON, 0o600), env: env({ FORCE: "1" }) }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.equal(run.sb.read(saPath(GOOD_JSON)), GOOD_JSON);
    });
  });

  it("an existing file under the same name with DIFFERENT content is never overwritten", async () => {
    await run1({ name: "gc-collide", setup: (sb) => sb.write(saPath(GOOD_JSON), "something else\n", 0o600) }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /already exists with different content; refusing to overwrite/);
      assert.deepEqual(writeEvents(run), []);
      assert.equal(run.sb.read(saPath(GOOD_JSON)), "something else\n");
    });
  });

  it("a Hermes that is not 0.22.5 is refused before anything", async () => {
    await run1({ name: "gc-ver", files: { "hermes.version": "hermes 0.17.2\n", "logs.txt": GOOD_LOGS } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /source-verified for Hermes 0\.22\.5 only/);
      assertStateIdentical(run);
      assert.equal(run.sb.curlCalls().length, 0);
    });
  });
});

const readdirKeyFiles = (run) => run.sb.ls(".hermes").filter((n) => /^google-chat-sa-.*\.json$/.test(n));

describe("platform-google-chat: hard gate (nothing written)", { concurrency: 4 }, () => {
  // ---- local checks: refused before any ssh or curl ----
  for (const [label, users, msg] of [
    ["empty", "", /GOOGLE_CHAT_ALLOWED_USERS is empty/],
    ["only separators", " , ,", /GOOGLE_CHAT_ALLOWED_USERS is empty/],
    ["*", "*", /wildcard/],
    ["an e-mail and *", "alice@example.com,*", /wildcard/],
    ["a bare name", "alice", /invalid entries/],
    ["a domain only", "@example.com", /invalid entries/],
    ["command injection", 'a@b.co; touch "$HOME/pwned"', /invalid entries/],
    ["command substitution", '$(touch "$HOME/pwned")@b.co', /invalid entries/],
  ]) {
    it(`allowlist ${JSON.stringify(label)} is refused before any ssh/curl`, async () => {
      await scenario({ name: "gc-allow", valid: [EMAIL], script: localGate(), env: env({ GOOGLE_CHAT_ALLOWED_USERS: users }) }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, msg);
        assert.match(run.out, /Nothing was written/);
        assert.equal(run.sb.sshCalls().length, 0);
        assert.equal(run.sb.curlCalls().length, 0);
        assert.ok(!run.sb.exists("pwned"));
      });
    });
  }

  const tinyKey = keyFile("{}\n");
  for (const [label, over, msg] of [
    ["a topic path as the subscription", { GOOGLE_CHAT_SUBSCRIPTION_NAME: `projects/${PROJECT}/topics/hermes-chat-events` }, /must be projects\/<project>\/subscriptions\/<subscription>/],
    ["a bare subscription ID", { GOOGLE_CHAT_SUBSCRIPTION_NAME: "hermes-chat-events-sub" }, /must be projects\//],
    ["a project mismatch", { GOOGLE_CHAT_SUBSCRIPTION_NAME: "projects/other-proj-9/subscriptions/hermes-chat-events-sub" }, /does not match GOOGLE_CHAT_PROJECT_ID/],
    ["an uppercase project ID", { GOOGLE_CHAT_PROJECT_ID: "My-Proj" }, /GOOGLE_CHAT_PROJECT_ID must be/],
    ["injection in the subscription", { GOOGLE_CHAT_SUBSCRIPTION_NAME: `projects/${PROJECT}/subscriptions/x';touch$IFS$HOME/pwned;'` }, /must be projects\//],
    ["a home channel that is not a space", { GOOGLE_CHAT_HOME_CHANNEL: "AAAA" }, /GOOGLE_CHAT_HOME_CHANNEL must be spaces/],
    ["a home channel with injection", { GOOGLE_CHAT_HOME_CHANNEL: "spaces/a;touch$IFS$HOME/pwned" }, /GOOGLE_CHAT_HOME_CHANNEL must be spaces/],
    ["no key path", { SA_KEY_LOCAL_PATH: "" }, /not a readable, non-empty file/],
    ["a missing key file", { SA_KEY_LOCAL_PATH: "/nonexistent/key.json" }, /not a readable, non-empty file/],
    ["an empty key file", { SA_KEY_LOCAL_PATH: keyFile("") }, /not a readable, non-empty file/],
    ["a key file of the wrong type", { SA_KEY_LOCAL_PATH: keyFile(saJson(KEY1.pem, { type: "authorized_user" })) }, /not a service-account key/],
    ["a key file without a private key", { SA_KEY_LOCAL_PATH: tinyKey }, /not a service-account key|lacks client_email or private_key/],
    ["an oversized key file", { SA_KEY_LOCAL_PATH: keyFile(saJson(KEY1.pem, { padding: "x".repeat(20000) })) }, /larger than 16 KiB/],
  ]) {
    it(`${label}: refused before any ssh, vendor call or write`, async () => {
      await scenario({ name: "gc-fmt", valid: [EMAIL], script: flow(), env: env(over), knobs: knobs() }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, msg);
        assert.match(run.out, /Nothing was written/);
        assert.equal(run.sb.curlCalls().length, 0);
        assert.deepEqual(writeEvents(run), []);
        assert.ok(!run.sb.exists("pwned"));
        assert.deepEqual(readdirKeyFiles(run), []);
      });
    });
  }

  // ---- the live Google check ----
  it("Google rejects the key (signature does not match the key Google holds): ABORT with the error, nothing uploaded or written", async () => {
    await run1({ name: "gc-badsig", knobs: { jwt_pubkey: KEY2.pub } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /ABORT: Google rejected the service-account key \(invalid_grant\)/);
      assert.deepEqual(writeEvents(run), []);
      assert.ok(!run.sb.exists(".hermes/.hstack-backup"));
      assert.deepEqual(readdirKeyFiles(run), []);
      assert.equal(run.sb.curlCalls().length, 1, "the subscription is not read with a rejected key");
      assertSecretsNotPrinted(run, SECRETS(GOOD_JSON, KEY1.pem));
    });
  });

  it("the service account is unknown to Google (not in the accepted list): ABORT", async () => {
    await run1({ name: "gc-unknown", valid: [] }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /Google rejected the service-account key/);
      assert.deepEqual(writeEvents(run), []);
    });
  });

  for (const [code, msg] of [
    ["403", /may not read the subscription.*Pub\/Sub Subscriber AND Pub\/Sub Viewer on the SUBSCRIPTION/],
    ["404", /subscription does not exist/],
    ["500", /unexpected answer from Pub\/Sub \(HTTP 500\)/],
  ]) {
    it(`Pub/Sub answers ${code} for the subscription: ABORT, nothing written`, async () => {
      await run1({ name: "gc-pubsub", knobs: { pubsub_status: code } }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, msg);
        assert.deepEqual(writeEvents(run), []);
        assert.deepEqual(readdirKeyFiles(run), []);
        assert.ok(!run.sb.exists(".hermes/.hstack-backup"));
      });
    });
  }

  it("the VPS cannot reach Google: ABORT, nothing written", async () => {
    await run1({ name: "gc-net", knobs: { net_down: true } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /could not complete the Google check/);
      assert.deepEqual(writeEvents(run), []);
    });
  });

  it("a key whose token_uri is not Google's is never used to sign a request", async () => {
    const bad = saJson(KEY1.pem, { token_uri: "https://evil.example.com/token" });
    await run1({ name: "gc-uri", env: env({ SA_KEY_LOCAL_PATH: keyFile(bad) }) }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /token_uri is not https:\/\/oauth2\.googleapis\.com\/token/);
      assert.equal(run.sb.curlCalls().length, 0);
      assert.deepEqual(writeEvents(run), []);
    });
  });

  it("openssl missing on the VPS is reported, not skipped", async () => {
    const script = flow({ replace: [["command -v openssl", "command -v nosuchopenssl"]] });
    await run1({ name: "gc-noossl", script }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /openssl is not installed on the VPS/);
      assert.deepEqual(writeEvents(run), []);
    });
  });

  // ---- the VPS look-over ----
  for (const [line, name] of [
    ["GOOGLE_CHAT_ALLOW_ALL_USERS=true", "GOOGLE_CHAT_ALLOW_ALL_USERS"], ["GATEWAY_ALLOW_ALL_USERS=1", "GATEWAY_ALLOW_ALL_USERS"], ["GOOGLE_CHAT_ALLOW_ALL_USERS=yes", "GOOGLE_CHAT_ALLOW_ALL_USERS"],
    ['GATEWAY_ALLOW_ALL_USERS="true"', "GATEWAY_ALLOW_ALL_USERS"], ["export GOOGLE_CHAT_ALLOW_ALL_USERS=on", "GOOGLE_CHAT_ALLOW_ALL_USERS"], [" GATEWAY_ALLOW_ALL_USERS = true", "GATEWAY_ALLOW_ALL_USERS"],
    ["GATEWAY_ALLOWED_USERS=a@b.co,*", "GATEWAY_ALLOWED_USERS"],
  ]) {
    it(`pre-existing ${line.trim()} aborts before any write`, async () => {
      await run1({ name: "gc-open", seed: { env: `FOO=bar\n${line}\n` } }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, new RegExp(`turns on open access \\(${name}\\)`));
        assertStateIdentical(run);
        assert.deepEqual(writeEvents(run), []);
        assert.equal(run.sb.curlCalls().length, 0);
      });
    });
  }
  it("explicitly-off or non-wildcard settings do not block", async () => {
    await run1({ name: "gc-off", seed: { env: "GOOGLE_CHAT_ALLOW_ALL_USERS=false\nGATEWAY_ALLOW_ALL_USERS=0\nGATEWAY_ALLOWED_USERS=a@b.co\n" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.ok(run.completed);
    });
  });

  it("an explicit platforms.google_chat.enabled: false refuses (the env would do nothing)", async () => {
    await run1({ name: "gc-disabled", seed: { config: "platforms.google_chat.enabled: false\n" } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /platforms\.google_chat\.enabled is false/);
      assertStateIdentical(run);
      assert.equal(run.sb.curlCalls().length, 0);
    });
  });
  for (const key of ["project_id", "subscription_name", "service_account_json", "http_events_url", "allowed_users", "allow_from"]) {
    it(`a platforms.google_chat.extra.${key} in config.yaml refuses (it is read before the env values)`, async () => {
      await run1({ name: "gc-shadow", seed: { config: `platforms.google_chat.extra.${key}: x\n` } }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, new RegExp(`platforms\\.google_chat in config\\.yaml already sets: ${key}`));
        assertStateIdentical(run);
        assert.equal(run.sb.curlCalls().length, 0);
      });
    });
  }
  it("a harmless platforms.google_chat block (typing_status_text) does not block", async () => {
    await run1({ name: "gc-benign", seed: { config: "platforms.google_chat.typing_status_text: pouncing\n" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
    });
  });

  it("lazy installs off refuses (the Google libraries could not be installed), unless declared preinstalled", async () => {
    await run1({ name: "gc-lazy", seed: { config: "security.allow_lazy_installs: false\n" } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /lazy installs are off on the VPS/);
      assertStateIdentical(run);
      assert.equal(run.sb.curlCalls().length, 0);
    });
    await run1({ name: "gc-lazy-env", seed: { env: "HERMES_DISABLE_LAZY_INSTALLS=true\n" } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.deepEqual(writeEvents(run), []);
    });
    await run1({ name: "gc-lazy-ok", seed: { config: "security.allow_lazy_installs: false\n" }, env: env({ GOOGLE_CHAT_DEPS_PREINSTALLED: "1" }) }, async (run) => {
      assert.equal(run.code, 0, run.out);
    });
  });

  it("a leftover snapshot makes snapshot refuse; no key file is uploaded", async () => {
    await run1({ name: "gc-left", ...withOld({ setup: (sb) => sb.write(".hermes/.hstack-backup/platform-google-chat/.env", "junk\n") }), env: env({ FORCE: "1" }) }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /did not finish/);
      assert.match(run.out, /ABORT: could not snapshot/);
      assert.deepEqual(writeEvents(run), []);
      assert.deepEqual(readdirKeyFiles(run), ["google-chat-sa-old.json"]);
    });
  });
});

describe("platform-google-chat: failure after the snapshot restores byte for byte", { concurrency: 4 }, () => {
  const cases = [
    ["config set GOOGLE_CHAT_ALLOWED_USERS fails", { "fail.set.GOOGLE_CHAT_ALLOWED_USERS": true }, /could not write GOOGLE_CHAT_ALLOWED_USERS/],
    ["config set GOOGLE_CHAT_SUBSCRIPTION_NAME fails (everything else already written)", { "fail.set.GOOGLE_CHAT_SUBSCRIPTION_NAME": true }, /could not write GOOGLE_CHAT_SUBSCRIPTION_NAME/],
    ["the third config set fails", { "fail.set_nth": "3\n" }, /could not write/],
    ["no google_chat line in the logs", { "fail.logs": true }, /did not appear as connected/],
    ["the stored key file cannot read the subscription after the reload", { curl_force: "4=403\n" }, /could not read the subscription \(HTTP 403\)/],
  ];
  for (const [label, kn, msg] of cases) {
    it(`FORCE=1 re-run with a new key: ${label}`, async () => {
      const newJson = saJson(KEY2.pem, { client_email: OTHER_EMAIL });
      await run1(
        { name: "gc-rb", ...withOld(), valid: [OTHER_EMAIL], knobs: { jwt_pubkey: KEY2.pub, ...kn }, env: env({ FORCE: "1", SA_KEY_LOCAL_PATH: keyFile(newJson), GOOGLE_CHAT_HOME_CHANNEL: "spaces/AAAA" }) },
        async (run) => {
          assert.equal(run.code, 1, run.out);
          assert.match(run.out, msg);
          assert.match(run.out, /rollback: restored/);
          assert.equal(sandboxOldEnv(run), oldState(run.sb.home).env);
          assert.equal(run.sb.read(".hermes/config.yaml"), oldState(run.sb.home).config);
          assert.ok(run.sb.exists(".hermes/google-chat-sa-old.json"), "the previous key file is intact");
          assert.ok(!run.sb.exists(saPath(newJson)), "the key file this run created is removed");
          assert.ok(!run.sb.exists(`${saPath(newJson)}.tmp`));
          assert.ok(run.sb.exists(".hermes/.hstack-backup/platform-google-chat.prev"));
          assert.ok(!run.sb.exists(".hermes/.hstack-backup/platform-google-chat"));
          assertSecretsNotPrinted(run, SECRETS(newJson, KEY2.pem));
        },
      );
    });
  }

  it("a key file that already existed before the run survives a failed run", async () => {
    await run1({ name: "gc-keep", setup: (sb) => sb.write(saPath(GOOD_JSON), GOOD_JSON, 0o600), knobs: { "fail.logs": true }, env: env({ FORCE: "1" }) }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.equal(run.sb.read(saPath(GOOD_JSON)), GOOD_JSON);
    });
  });

  it("the upload itself failing rolls back and leaves no file", async () => {
    await run1({ name: "gc-upfail", setup: (sb) => mkdirSync(path.join(sb.home, `${saPath(GOOD_JSON)}.tmp`), { recursive: true }) }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /could not upload the service-account key/);
      assert.match(run.out, /rollback: restored|rollback: no snapshot|nothing was written/i);
      assert.ok(!run.sb.exists(saPath(GOOD_JSON)));
      assert.ok(!run.sb.exists(".hermes/.env"), "a first run leaves nothing behind");
      assert.deepEqual(writeEvents(run).filter((e) => e.startsWith("hermes config set")), []);
    });
  });

  it("a key file that is not mode 600 after the upload is caught", async () => {
    const script = flow({ replace: [["COUNT=$(remote", 'chmod 644 "$HOME"/.hermes/google-chat-sa-*.json\nCOUNT=$(remote']] });
    await run1({ name: "gc-mode", script }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /the key file is mode 644, not 600/);
      assert.ok(!run.sb.exists(".hermes/.env"));
      assert.deepEqual(readdirKeyFiles(run), []);
    });
  });

  it("open access appearing during the write is caught after the write and rolled back", async () => {
    const script = flow({ replace: [["COUNT=$(remote", `printf 'GATEWAY_ALLOW_ALL_USERS=true\\n' >> "$HOME/.hermes/.env"\nCOUNT=$(remote`]] });
    await run1({ name: "gc-inject", ...withOld(), script, env: env({ FORCE: "1" }), valid: [EMAIL] }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /turns on open access \(GATEWAY_ALLOW_ALL_USERS\)/);
      assert.equal(sandboxOldEnv(run), oldState(run.sb.home).env);
      assert.deepEqual(readdirKeyFiles(run), ["google-chat-sa-old.json"]);
    });
  });

  it("a failing home-space send rolls back and says how to proceed", async () => {
    await run1({ name: "gc-send", ...withOld(), knobs: { "fail.send": true }, env: env({ FORCE: "1", GOOGLE_CHAT_HOME_CHANNEL: "spaces/AAAA" }) }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /test message to the Google Chat home space failed/);
      assert.equal(sandboxOldEnv(run), oldState(run.sb.home).env);
    });
  });

  it("first run (no .env before): rollback removes the files this skill created, key file included", async () => {
    await run1({ name: "gc-first", knobs: { "fail.logs": true } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.ok(!run.sb.exists(".hermes/.env"));
      assertStateIdentical(run);
      assert.deepEqual(readdirKeyFiles(run), []);
    });
  });

  it("the gateway never restarts ready: files restored, snapshot AND the new key file kept; retrying rollback recovers", async () => {
    await run1({ name: "gc-rb-gw", ...withOld(), knobs: { "fail.gateway.restart": true }, env: env({ FORCE: "1" }), valid: [EMAIL] }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /gateway did not restart ready/);
      assert.match(run.out, /files restored, but the gateway did NOT come back/);
      assert.match(run.out, /rollback did not complete: the key file/);
      assert.equal(sandboxOldEnv(run), oldState(run.sb.home).env);
      assert.ok(run.sb.exists(".hermes/.hstack-backup/platform-google-chat"));
      assert.ok(run.sb.exists(saPath(GOOD_JSON)), "the new key file stays until the recovery point is resolved");
      const retry = assemble([{ skill: SKILL, ids: ["step0#1"] }, 'rm "$HSTACK_FAKE/knobs/fail.gateway.restart"\nrollback || exit 1\necho RECOVERED\n']);
      const recovered = await run.sb.run(retry);
      assert.equal(recovered.code, 0, recovered.out);
      assert.ok(run.sb.exists(".hermes/.hstack-backup/platform-google-chat.prev"));
    });
  });

  it("live sessions: the restart refusal is reported and never forced with -y", async () => {
    await run1({ name: "gc-live", ...withOld(), knobs: { live_sessions: true }, env: env({ FORCE: "1" }) }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /refused|live session/i);
      assert.ok(run.sb.exists(".hermes/.hstack-backup/platform-google-chat"));
      assert.ok(!run.sb.hermesCalls().some((c) => c.some((x) => ["-y", "--yes", "--force", "--all", "--interrupt"].includes(x))));
    });
  });
});

describe("platform-google-chat: what counts as connected in the gateway log", { concurrency: 4 }, () => {
  const L = (...lines) => lines.join("\n") + "\n";
  const cases = [
    ["the runner's connected line", L("2026-01-01 INFO gateway.run: ✓ google_chat connected"), true],
    ["the adapter's own line alone", L("INFO [GoogleChat] Connected; project=p, inbound=pubsub, subscription=<redacted>"), true],
    ["failure then a newer success", L("✗ google_chat failed to connect", "✓ google_chat connected"), true],
    ["success then a newer failure", L("✓ google_chat connected", "✗ google_chat failed to connect"), false],
    ["success then a dead Pub/Sub stream", L("✓ google_chat connected", "WARNING [GoogleChat] Pub/Sub stream died (attempt 1/10): boom"), false],
    ["success then a disconnect", L("✓ google_chat connected", "✓ google_chat disconnected (0.10s)"), false],
    ["a degraded connect", L("✓ google_chat connected (degraded)"), false],
    ["config validation failed", L("ERROR [GoogleChat] Config validation failed: GOOGLE_CHAT_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) is not set."), false],
    ["subscription.get failed", L("ERROR [GoogleChat] subscription.get failed: boom"), false],
    ["a fatal adapter error", L("✓ google_chat connected", "ERROR Fatal google_chat adapter error (subscription_not_found): Pub/Sub subscription not found at configured path"), false],
    ["missing libraries", L("ERROR Fatal google_chat adapter error (missing_deps): google-cloud-pubsub / google-api-python-client not installed"), false],
    ["the startup summary of a parked platform", L("ERROR 1 configured platform(s) failed to start and are parked (fix the reported error): google_chat: Pub/Sub subscription not found"), false],
    ["only another platform is connected", L("✓ telegram connected"), false],
    ["Connecting... but no result", L("INFO Connecting to google_chat..."), false],
  ];
  for (const [label, logs, want] of cases) {
    it(`${label}: ${want ? "connected" : "not connected (rolls back)"}`, async () => {
      await run1({ name: "gc-logs", files: { "logs.txt": logs } }, async (run) => {
        if (want) {
          assert.equal(run.code, 0, run.out);
        } else {
          assert.equal(run.code, 1, run.out);
          assert.match(run.out, /did not appear as connected/);
          assert.ok(!run.sb.exists(".hermes/.env"));
          assert.deepEqual(readdirKeyFiles(run), []);
        }
      });
    });
  }
});

describe("platform-google-chat: the service-account key stays out of argv, output and config", { concurrency: 4 }, () => {
  it("on a failing run too: no ssh command string, curl argv or output ever contains the key", async () => {
    await run1({ name: "gc-sec-fail", knobs: { "fail.logs": true } }, async (run) => {
      assert.equal(run.code, 1);
      assertNoSecretInArgv(run, SECRETS(GOOD_JSON, KEY1.pem));
      assertSecretsNotPrinted(run, SECRETS(GOOD_JSON, KEY1.pem));
    });
  });

  it("CONTROL: a skill that put the key in the ssh command would be caught by the same check", async () => {
    // Mutate the upload so the first 600 bytes of the key file ride in the ssh command string; the argv check must now fail.
    const script = flow({ replace: [['remote "umask 077;', 'remote "KEY=$(head -c 600 "$SA_KEY_LOCAL_PATH" | tr -d \'\\n\'); umask 077;']] });
    await run1({ name: "gc-sec-ctl", script }, async (run) => {
      assert.throws(() => assertNoSecretInArgv(run, [keySlice(KEY1.pem).slice(0, 12)]), /a secret appears in ssh call/);
    });
  });
});

describe("platform-google-chat: negative controls (the tests can see each defect)", { concurrency: 4 }, () => {
  it("CONTROL: without the exit after a rejected key, the run would continue and write", async () => {
    assert.ok(loadBlocks(SKILL).find((b) => b.id === "step3#3").code.includes('Google rejected the service-account key (${PF#ERR token:}). Typical causes: the key was deleted or disabled, or the VPS clock is wrong. Nothing was written."; exit 1 ;;'));
    const script = flow({ replace: [['the VPS clock is wrong. Nothing was written."; exit 1 ;;', 'the VPS clock is wrong. Nothing was written." ;;']] });
    await run1({ name: "gc-ctl-exit", script, knobs: { jwt_pubkey: KEY2.pub } }, async (run) => {
      assert.ok(writeEvents(run).length > 0, "the mutated skill wrote after a rejected key, so the real test above can detect that");
    });
  });

  it("CONTROL: with the open-access names removed from the scanner, GOOGLE_CHAT_ALLOW_ALL_USERS=true slips through", async () => {
    const script = flow({ replace: [["(GOOGLE_CHAT_ALLOW_ALL_USERS|GATEWAY_ALLOW_ALL_USERS|GATEWAY_ALLOWED_USERS)=/) next", "(NOSUCH_NAME_ONE|NOSUCH_NAME_TWO|NOSUCH_NAME_THREE)=/) next"]] });
    await run1({ name: "gc-ctl-open", seed: { env: "GOOGLE_CHAT_ALLOW_ALL_USERS=true\n" }, script }, async (run) => {
      assert.ok(!run.out.includes("turns on open access"), run.out);
      assert.ok(writeEvents(run).length > 0);
    });
  });

  it("CONTROL: without the cleanup of the key file, a failed run leaves it behind", async () => {
    const script = flow({ replace: [["    sa_cleanup\n", "    :\n"]] });
    await run1({ name: "gc-ctl-clean", script, knobs: { "fail.logs": true } }, async (run) => {
      assert.equal(run.code, 1);
      assert.deepEqual(readdirKeyFiles(run), [saPath(GOOD_JSON).replace(".hermes/", "")]);
    });
  });

  it("CONTROL: without the rollback on a missing connected log, the previous values are NOT restored", async () => {
    const script = flow({ replace: [['gc_fail "FAIL: Google Chat did not appear as connected in the gateway log within 60s. Rolling back."', 'echo "FAIL"; exit 1']] });
    await run1({ name: "gc-ctl-rb", ...withOld(), knobs: { "fail.logs": true }, script, env: env({ FORCE: "1" }) }, async (run) => {
      assert.equal(run.code, 1);
      assert.notEqual(sandboxOldEnv(run), oldState(run.sb.home).env, "the mutated skill leaves the half-written state behind");
    });
  });
});

describe("platform-google-chat: text-level guarantees", () => {
  const text = readFileSync(skillPath(SKILL), "utf8");
  const blocks = loadBlocks(SKILL);
  const codeLines = blocks.flatMap((b) => b.code.split("\n").filter((l) => !/^\s*#/.test(l)));

  it("names the human steps and the v0.22.5 facts the legacy text got wrong", () => {
    assert.match(text, /\*\*Human\*\*/);
    assert.match(text, /Pub\/Sub Publisher on the topic/);
    assert.match(text, /There is \*\*no `GOOGLE_CHAT_ENABLED` variable\*\*/);
    assert.match(text, /default is\s+\*\*deny\*\*/);
    assert.match(text, /Pub\/Sub pull only/);
    assert.match(text, /## Verified against Hermes v0\.22\.5/);
    assert.match(text, /plugins\/platforms\/google_chat\/adapter\.py/);
    assert.match(text, /\*\*Not verified:\*\*/);
  });

  it("never writes GOOGLE_CHAT_ENABLED, never uses a retired lifecycle, never gcloud, never appends to .env by hand", () => {
    for (const l of codeLines) {
      assert.ok(!/GOOGLE_CHAT_ENABLED/.test(l), l);
      assert.ok(!/gateway (run|stop)|--daemon|gcloud/.test(l), l);
      assert.ok(!/>>\s*\S*\.env/.test(l), l);
    }
  });

  it("every hermes call in a block is bound to the default profile", () => {
    // only lines that run something (through remote, or a bare hermes), not prose in a printed message
    for (const l of codeLines.filter((x) => /\bremote\b|^\s*hermes\b/.test(x) && !/^\s*(echo|HOME_LINE=)/.test(x))) {
      assert.doesNotMatch(l, /\bhermes (?!-p default)(config|gateway|logs|send|pairing|mcp|cron|setup|status|doctor)\b/, l);
    }
  });

  it("the key file is never scp'd or expanded into a remote command string", () => {
    for (const l of codeLines) {
      assert.ok(!/\bscp\b/.test(l), l);
      assert.ok(!/remote\s+["'][^|]*\$\(cat\b/.test(l), l);
    }
  });
});
