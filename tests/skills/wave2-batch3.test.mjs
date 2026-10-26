// Real recipe snippets + installed local clients against isolated offline vendor/process models.
// The pinned argparse fixture proves syntax; none of these tests is live vendor or Hermes proof.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { assemble, loadBlocks, skillPath, TEMPLATE_PATH } from "./helpers/blocks.mjs";
import { checkAgainstV0225, hermesInvocations } from "./helpers/hermes-calls.mjs";
import { assertStateIdentical, assertSecretsNotPrinted } from "./helpers/asserts.mjs";
import { scenario } from "./helpers/sandbox.mjs";

const vendors = ["replicate", "salesforce", "segment", "sendbird", "sendgrid", "sentry", "shopify", "stripe", "supabase", "supermemory", "tally", "tavily", "trello", "twilio", "typeform", "vercel", "webflow", "woocommerce", "wordpress", "zendesk", "zoho-crm", "zoom"];
const token = tag => ["public", "Fixture", tag, "x".repeat(42)].join("");
const tok = token("Key");
const basicRef = "$" + "{MCP_FIXTURE_API_KEY}";
const basic = (u, p) => Buffer.from(`${u}:${p}`).toString("base64");
const ref = "a".repeat(20);
const envs = {
  replicate: { REPLICATE_API_TOKEN: ["r8", "_", "f".repeat(40)].join("") },
  salesforce: { SF_INSTANCE_URL: "https://fixture.my.salesforce.com", SF_CLIENT_ID: token("Client"), SF_CLIENT_SECRET: tok },
  segment: { SEGMENT_WRITE_KEY: tok, SEGMENT_REGION: "us", WRITE_ONLY_ACKNOWLEDGED: "1" },
  sendbird: { SENDBIRD_APP_ID: ["a".repeat(8), "b".repeat(4), "c".repeat(4), "d".repeat(4), "e".repeat(12)].join("-"), SENDBIRD_API_TOKEN: tok },
  sendgrid: { SENDGRID_API_KEY: ["SG", token("A"), token("B")].join("."), SENDGRID_FROM: "fixture@example.test" },
  sentry: { SENTRY_ACCESS_TOKEN: tok, SENTRY_HOST: "sentry.io", SENTRY_ORG: "fixture-org" },
  shopify: { SHOPIFY_SHOP_DOMAIN: "fixture.myshopify.com", SHOPIFY_API_VERSION: "2025-01", SHOPIFY_ACCESS_TOKEN: ["shpat", "_", "s".repeat(40)].join("") },
  stripe: { STRIPE_TOKEN: ["rk", "_test_", "s".repeat(40)].join(""), MODE_EXPECT: "test" },
  supabase: { SUPABASE_PAT: ["sbp", "_", "s".repeat(40)].join(""), SUPABASE_PROJECT_REF: ref, SUPABASE_READ_ONLY: "1" },
  supermemory: { SUPERMEMORY_API_KEY: ["sm", "_", "s".repeat(40)].join(""), SUPERMEMORY_HOST: "https://memory.example.test" },
  tally: { TALLY_TOKEN: ["tly", "-", "s".repeat(40)].join("") },
  tavily: { TAVILY_TOKEN: ["tvly", "-", "s".repeat(40)].join("") },
  trello: { TRELLO_API_KEY: "a".repeat(32), TRELLO_TOKEN: "b".repeat(64) },
  twilio: { TWILIO_ACCOUNT_SID: ["AC", "a".repeat(32)].join(""), TWILIO_API_KEY: ["SK", "b".repeat(32)].join(""), TWILIO_API_SECRET: tok, TWILIO_FROM: ["+1", "5".repeat(10)].join(""), TWILIO_REGION: "us1" },
  typeform: { TYPEFORM_TOKEN: ["tfp", "_", "s".repeat(40)].join("") },
  vercel: { VERCEL_TOKEN: tok },
  webflow: { WEBFLOW_TOKEN: tok, WEBFLOW_SITE_ID: "fixture-site" },
  woocommerce: { WOOCOMMERCE_URL: "https://store.example.test", WOOCOMMERCE_CONSUMER_KEY: ["ck", "_", "a".repeat(40)].join(""), WOOCOMMERCE_CONSUMER_SECRET: ["cs", "_", "b".repeat(40)].join("") },
  wordpress: { WP_URL: "https://site.example.test", WP_USERNAME: "fixture", WP_APP_PASSWORD: "p".repeat(24) },
  zendesk: { ZENDESK_SUBDOMAIN: "fixture", ZENDESK_EMAIL: "fixture@example.test", ZENDESK_API_TOKEN: tok },
  "zoho-crm": { ZOHO_MCP_URL: `https://mcp.zoho.com/${tok}`, ZOHO_AUTH_MODE: "connections" },
  zoom: { ZOOM_ACCOUNT_ID: "fixture-account", ZOOM_CLIENT_ID: token("Client"), ZOOM_CLIENT_SECRET: tok },
};
const defaultModes = Object.fromEntries(vendors.map(n => [n, ["sentry", "stripe", "supabase", "vercel", "webflow"].includes(n) ? "catalog" : ["shopify", "supermemory", "tally", "tavily", "zoho-crm"].includes(n) ? "mcp" : "rest"]));
const seed = { env: "PUBLIC_FIXTURE=keep\n", config: "model.default: previous/model\n" };
const body = {
  replicate: { username: "fixture", type: "user" }, salesforce: { access_token: "offline-access", instance_url: "https://fixture.my.salesforce.com" }, segment: { workspaces: [] },
  sendbird: { users: [] }, sendgrid: { scopes: ["mail.send"] }, sentry: { name: "Fixture" }, shopify: { jsonrpc: "2.0", id: 1, result: {} },
  stripe: { id: "acct_fixture" }, supabase: [{ id: ref }], supermemory: { jsonrpc: "2.0", id: 1, result: {} }, tally: { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "read" }] } }, tavily: { jsonrpc: "2.0", id: 1, result: {} },
  trello: { username: "fixture" }, twilio: { messages: [] }, typeform: { email: "fixture@example.test" }, vercel: { username: "fixture", projects: [] }, webflow: { sites: [{ id: "fixture-site" }] },
  woocommerce: [], wordpress: { roles: ["administrator"] }, zendesk: { user: { name: "Fixture", role: "admin" } }, "zoho-crm": { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "read" }] } }, zoom: { access_token: "offline-access" },
};
function validFor(vendor) {
  const e = envs[vendor];
  return [...Object.values(e), "offline-access", ...(["twilio", "woocommerce", "wordpress", "zendesk", "zoom"].includes(vendor) ? [vendor === "twilio" ? basic(e.TWILIO_API_KEY, e.TWILIO_API_SECRET) : vendor === "woocommerce" ? basic(e.WOOCOMMERCE_CONSUMER_KEY, e.WOOCOMMERCE_CONSUMER_SECRET) : vendor === "wordpress" ? basic(e.WP_USERNAME, e.WP_APP_PASSWORD) : vendor === "zendesk" ? basic(`${e.ZENDESK_EMAIL}/token`, e.ZENDESK_API_TOKEN) : basic(e.ZOOM_CLIENT_ID, e.ZOOM_CLIENT_SECRET)] : [])];
}
function knobsFor(vendor) {
  const knobs = { mcp_oauth_ok: true, curl_routes: `https://\t${JSON.stringify(body[vendor])}\n` };
  if (vendor === "shopify") knobs.curl_force = "1=200\n"; // Public Storefront initialize carries no token.
  return knobs;
}
const ids = (vendor, end = 8) => loadBlocks(`integration-${vendor}`).filter(b => /^step[0-8]#/.test(b.id) && Number(/^step(\d)/.exec(b.id)[1]) <= end).map(b => b.id);
const flow = (vendor, end = 8, tail = "") => assemble(["set +e\n", { skill: `integration-${vendor}`, ids: ids(vendor, end) }, tail, 'echo SCRIPT-COMPLETED\n']);
const fullEnv = vendor => ({ FORCE: "1", WRITES_ACKNOWLEDGED: "1", ...envs[vendor] });
// A fenced block's grammar check treats heredocs as data. Check the source executed by the remote shell separately.
const vendorProbe = vendor => {
  const block = loadBlocks(`integration-${vendor}`).find(b => b.id === "step3#1");
  const probes = [...block.code.matchAll(/^\s*cat <<'VENDOR_PROBE'\n([\s\S]*?)^VENDOR_PROBE$/gm)];
  assert.equal(probes.length, 1, `${vendor}: exactly one executable vendor probe must be checked`);
  return probes[0][1];
};
const bashGrammar = code => spawnSync("/bin/bash", ["-n"], { input: code, encoding: "utf8" });

describe("wave2 batch3: source-bound native surfaces", () => {
  for (const vendor of vendors) {
    it(`${vendor}: every actual CLI invocation parses and every bash block is complete`, () => {
      const text = readFileSync(skillPath(`integration-${vendor}`), "utf8");
      const rows = checkAgainstV0225(hermesInvocations(text));
      assert.deepEqual(rows.filter(r => r.code).map(r => `${r.line}: ${r.argv.join(" ")} ${r.output}`), []);
      for (const b of loadBlocks(`integration-${vendor}`)) {
        const result = spawnSync("/bin/bash", ["-n"], { input: b.code, encoding: "utf8" });
        assert.equal(result.status, 0, `${vendor} ${b.id}: ${result.stderr}`);
      }
      const probe = bashGrammar(vendorProbe(vendor));
      assert.equal(probe.status, 0, `${vendor} embedded VENDOR_PROBE: ${probe.stderr}`);
      assert.doesNotMatch(text, /gateway run --daemon|--auth-header|--auth-scheme|--placeholder-token|gateway env|gateway stop;/);
    });
  }
});

it("the embedded-probe grammar guard rejects an empty retired branch even inside a valid outer heredoc", () => {
  const broken = vendorProbe("sendgrid") + "\nif false; then\nfi\n";
  const outer = "cat <<'VENDOR_PROBE'\n" + broken + "VENDOR_PROBE\n";
  assert.equal(bashGrammar(outer).status, 0, "outer heredoc syntax alone cannot validate its executable contents");
  const inner = bashGrammar(broken);
  assert.equal(inner.status, 2);
  assert.match(inner.stderr, /syntax error.*fi/);
});

describe("wave2 batch3: complete executable default routes", { concurrency: 4 }, () => {
  for (const vendor of vendors) {
    it(`${vendor}: credential/consent gate, native install, actual client/MCP smoke, new ready gateway and retained recovery`, async () => {
      await scenario({ name: `w2-b3-${vendor}`, seed, script: flow(vendor), env: fullEnv(vendor), valid: validFor(vendor), knobs: knobsFor(vendor) }, async run => {
        assert.equal(run.code, 0, run.out);
        // Bash 3.2 can reset a streamed parser error to exit 0 after an EXIT cleanup trap.
        assert.doesNotMatch(run.out, /syntax error|unexpected token/i);
        assert.ok(run.completed);
        assert.ok(run.sb.exists(`.hermes/skills/hstack-${vendor}/SKILL.md`));
        assert.ok(run.sb.exists(`.hermes/skills/hstack-${vendor}/client.py`));
        assert.ok(run.sb.exists(`.hermes/.hstack-backup/integration-${vendor}.prev/.native-state`));
        assert.equal(run.sb.mode(".hermes/.env"), 0o600);
        const calls = run.sb.hermesCalls().map(c => c.join(" "));
        assert.ok(calls.includes("skills list --source local --enabled-only"));
        if (defaultModes[vendor] !== "rest") assert.ok(calls.some(c => c.startsWith("mcp test ")));
        else if (vendor !== "segment") assert.ok(run.sb.curlCalls().length >= 2, "probe + actual installed client request");
        assert.ok(calls.includes("gateway restart --detach"));
        assert.ok(!calls.some(c => /gateway stop|gateway run| -y$/.test(c)));
        assert.ok(run.sb.curlCalls().every(c => c.argv_has_token === "0"));
        assert.ok(run.sb.curlCalls().every(c => c.argv.startsWith("-q --config -")), "curlrc defaults must be disabled before auth config is read");
      });
    });
  }
});

it("native catalog install/login exit0 without OAuth approval never becomes connection proof", async () => {
  await scenario({ name: "w2-b3-oauth-refusal", seed, script: flow("stripe"), env: fullEnv("stripe"), knobs: {} }, async run => {
    assert.equal(run.code, 1, run.out);
    assertStateIdentical(run);
    assert.ok(!run.sb.exists(".hermes/skills/hstack-stripe"));
    assert.match(run.out, /not authenticated|not.*reachable/);
  });
});

for (const response of [{ error: { code: "invalid_api_key" } }, { error: { type: "permission_error" } }]) {
  it(`Stripe ${JSON.stringify(response)} aborts before snapshot, including HTTP200 error bodies`, async () => {
    await scenario({ name: "w2-b3-stripe-invalid", seed, script: flow("stripe"), env: { ...fullEnv("stripe"), CONNECTOR_MODE: "rest" }, valid: validFor("stripe"), knobs: { curl_routes: `https://\t${JSON.stringify(response)}\n` } }, async run => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /ABORT: Stripe did not prove a positive read/);
      assert.ok(!run.sb.exists(".hermes/.hstack-backup"));
      assertStateIdentical(run);
    });
  });
}

it("the installed Typeform client reads actual persisted credentials, refuses writes/redirects/traversal and never puts auth in argv", async () => {
  const tail = `remote 'python3 ~/.hermes/skills/hstack-typeform/client.py /forms --method POST'; echo "WRITE_RC=$?"
remote 'python3 ~/.hermes/skills/hstack-typeform/client.py //other.example.test'; echo "ORIGIN_RC=$?"
remote 'python3 ~/.hermes/skills/hstack-typeform/client.py /../escape'; echo "PATH_RC=$?"
printf '3=302\\n' > "$HOME/knobs/curl_force"
remote 'python3 ~/.hermes/skills/hstack-typeform/client.py'; echo "REDIRECT_RC=$?"
`;
  await scenario({ name: "w2-b3-client", seed, script: flow("typeform", 8, tail), env: fullEnv("typeform"), valid: validFor("typeform"), knobs: knobsFor("typeform"), setup: sb => sb.write(".curlrc", "location\nheader = \"X-Default: must-not-apply\"\n") }, async run => {
    assert.match(run.out, /WRITE_RC=1/);
    assert.match(run.out, /ORIGIN_RC=1/);
    assert.match(run.out, /PATH_RC=1/);
    assert.match(run.out, /REDIRECT_RC=1/);
    assert.ok(run.sb.curlCalls().every(c => c.argv_has_token === "0"));
    assert.ok(!run.sb.curlCalls().some(c => c.url.includes("other.example.test")));
    assert.ok(run.sb.curlCalls().every(c => c.argv.startsWith("-q --config -")), "-q must precede config so ~/.curlrc cannot enable redirect following");
    assertSecretsNotPrinted(run, [envs.typeform.TYPEFORM_TOKEN]);
  });
});

it("FORCE rollback restores the previous native skill/client and prior env/config byte for byte", async () => {
  const tail = `remote 'd=$HOME/.hermes/.hstack-backup/integration-typeform; mv "$d.prev" "$d"'
integration_rollback; echo "UNDO_RC=$?"
`;
  await scenario({ name: "w2-b3-owned-rollback", seed, script: flow("typeform", 8, tail), env: fullEnv("typeform"), valid: validFor("typeform"), knobs: knobsFor("typeform"), setup: sb => {
    sb.write(".hermes/skills/hstack-typeform/.hstack-owner", "integration-typeform\n", 0o600);
    sb.write(".hermes/skills/hstack-typeform/SKILL.md", "previous exact skill bytes\n", 0o640);
    sb.write(".hermes/skills/hstack-typeform/client.py", "previous exact client bytes\n", 0o640);
  } }, async run => {
    assert.match(run.out, /UNDO_RC=0/);
    assertStateIdentical(run);
    assert.equal(run.sb.read(".hermes/skills/hstack-typeform/SKILL.md"), "previous exact skill bytes\n");
    assert.equal(run.sb.read(".hermes/skills/hstack-typeform/client.py"), "previous exact client bytes\n");
    assert.equal(run.sb.mode(".hermes/skills/hstack-typeform/client.py"), 0o640);
  });
});

it("credential failure and an unowned native skill path never publish a snapshot or replace files", async () => {
  for (const mode of ["credential", "unowned"]) {
    await scenario({ name: "w2-b3-prewrite", seed, script: flow("typeform"), env: fullEnv("typeform"), valid: mode === "credential" ? [] : validFor("typeform"), knobs: knobsFor("typeform"), setup: mode === "unowned" ? sb => sb.write(".hermes/skills/hstack-typeform/SKILL.md", "user-owned\n") : undefined }, async run => {
      assert.equal(run.code, 1, run.out);
      assertStateIdentical(run);
      assert.ok(!run.sb.exists(".hermes/.hstack-backup"));
      if (mode === "unowned") assert.equal(run.sb.read(".hermes/skills/hstack-typeform/SKILL.md"), "user-owned\n");
    });
  }
});

it("shared models expose exact catalog endpoints, local enabled filtering, structured Basic headers, and output+write-out separately", async () => {
  const script = assemble(["set +e\n", { skill: TEMPLATE_PATH, ids: ["step0#1"], placeholders: { "skill-name": "shared-proof" } }, `remote 'hermes -p default mcp install official/asana'
remote 'hermes -p default mcp test asana'; echo "UNAUTH_RC=$?"
printf '%s\\n' '${basic("fixture", tok)}' | remote 'IFS= read -r v && hermes -p default config set MCP_FIXTURE_API_KEY "$v" >/dev/null'
printf '%s\\n' '{"url":"https://fixture.example.test/mcp","headers":{"Authorization":"Basic ${basicRef}"},"enabled":true}' | remote 'IFS= read -r config && hermes -p default config set mcp_servers.fixture "$config"'
remote 'hermes -p default mcp list'
remote 'hermes -p default mcp test fixture'; echo "BASIC_RC=$?"
`]);
  await scenario({ name: "w2-b3-shared-models", script }, async run => {
    assert.match(run.out, /UNAUTH_RC=1/);
    assert.match(run.out, /BASIC_RC=0/);
    assert.match(run.sb.read(".hermes/config.yaml"), /https:\/\/mcp.asana.com\/v2\/mcp/);
    assert.match(run.out, /fixture .*enabled/);
  });
});

it("Salesforce rejects invalid client credentials before snapshot, and sends probe secrets only via stdin", async () => {
  await scenario({ name: "w2-b3-sf-invalid", seed, script: flow("salesforce"), env: fullEnv("salesforce"), valid: [], knobs: { curl_routes: 'https://\t{"error":"invalid_client"}\n' }, setup: sb => {
    sb.write("remote_bin/python3", '#!/bin/bash\nprintf "%s\\n" "$*" >> "$HOME/logs/python-argv.log"\nexec /usr/bin/python3 "$@"\n', 0o755);
  } }, async run => {
    assert.equal(run.code, 1, run.out);
    assert.ok(run.sb.curlCalls().some(c => c.url.endsWith("/services/oauth2/token")), "the REST route must actually authenticate before writing");
    assert.ok(!run.sb.exists(".hermes/.hstack-backup"));
    assertStateIdentical(run);
    assert.ok(!run.sb.log("python-argv.log").includes(envs.salesforce.SF_CLIENT_SECRET));
    assert.ok(run.sb.curlCalls().every(c => c.argv_has_token === "0"));
  });
});

it("each headless default route probes before its first native config mutation; Segment explicitly sends no event", async () => {
  // A representative auth flow of each protocol: bearer, Basic, OAuth token exchange and write-only source.
  for (const vendor of ["typeform", "woocommerce", "salesforce", "segment"]) {
    await scenario({ name: "w2-b3-probe-order", seed, script: flow(vendor), env: fullEnv(vendor), valid: validFor(vendor), knobs: knobsFor(vendor) }, async run => {
      assert.equal(run.code, 0, run.out);
      const events = run.sb.events();
      const firstWrite = events.findIndex(e => /^hermes config set/.test(e));
      if (vendor === "segment") {
        assert.match(run.out, /no event sent|no live authentication claim/);
        assert.equal(run.sb.curlCalls().length, 0);
      } else {
        const probe = events.findIndex(e => /^curl status=200/.test(e));
        assert.ok(probe >= 0 && firstWrite > probe, events.join("\n"));
      }
    });
  }
});

for (const vendor of ["supabase", "webflow"]) {
  it(`${vendor} selected scope accepts spaced/reordered JSON structurally`, async () => {
    const spaced = vendor === "supabase" ? `[ { "name": "Fixture", "id": "${ref}" } ]` : '{ "other": false, "sites": [ { "name": "Fixture", "id": "fixture-site" } ] }';
    await scenario({ name: "w2-b3-json-scope", seed, script: flow(vendor, 3), env: { ...fullEnv(vendor), CONNECTOR_MODE: "rest" }, valid: validFor(vendor), knobs: { curl_routes: `https://\t${spaced}\n` } }, async run => {
      assert.equal(run.code, 0, run.out);
      assertStateIdentical(run);
      assert.ok(!run.sb.exists(".hermes/.hstack-backup"));
    });
  });
}

it("Zoho rejects a forged region and Supermemory rejects injected project-header arguments before any credential call", async () => {
  const cases = [
    ["zoho-crm", { CONNECTOR_MODE: "rest", ZOHO_DC: "com.evil.example.invalid", ZOHO_CRM_CLIENT_ID: tok, ZOHO_CRM_CLIENT_SECRET: tok, ZOHO_CRM_REFRESH_TOKEN: tok }],
    ["supermemory", { SUPERMEMORY_PROJECT_ID: "scope https://evil.example.invalid" }],
  ];
  for (const [vendor, overrides] of cases) {
    await scenario({ name: "w2-b3-fixed-host", seed, script: flow(vendor, 3), env: { ...fullEnv(vendor), ...overrides }, valid: validFor(vendor), knobs: knobsFor(vendor) }, async run => {
      assert.equal(run.code, 1, run.out);
      assert.equal(run.sb.curlCalls().length, 0);
      assertStateIdentical(run);
      assert.ok(!run.sb.exists(".hermes/.hstack-backup"));
    });
  }
});

const switchedNames = { sentry: "sentry", stripe: "stripe", supabase: "supabase", vercel: "vercel", webflow: "webflow", wordpress: "wordpress-com", shopify: "shopify-storefront", supermemory: "supermemory", tally: "tally", tavily: "tavily", "zoho-crm": "zoho-crm" };
describe("REST route switches remove only the previous known native connector transactionally", { concurrency: 4 }, () => {
  for (const [vendor, previous] of Object.entries(switchedNames)) {
    it(`${vendor} removes ${previous}, keeps unrelated tools, and rollback restores the previous config`, async () => {
      const oldConfig = `model.default: previous/model\nmcp.${previous}:\n  url: https://previous.example.test/mcp\n  enabled: true\nmcp.unrelated:\n  url: https://unrelated.example.test/mcp\n  enabled: true\n`;
      const tail = `remote 'hermes -p default mcp test ${previous}'; echo "REMOVED_RC=$?"
remote 'hermes -p default mcp test unrelated'; echo "UNRELATED_RC=$?"
integration_rollback; echo "UNDO_RC=$?"
`;
      const env = { ...fullEnv(vendor), CONNECTOR_MODE: "rest" };
      const knobs = knobsFor(vendor);
      if (vendor === "shopify") delete knobs.curl_force; // Admin REST is authenticated.
      if (vendor === "zoho-crm") {
        Object.assign(env, { ZOHO_DC: "com", ZOHO_CRM_CLIENT_ID: tok, ZOHO_CRM_CLIENT_SECRET: tok, ZOHO_CRM_REFRESH_TOKEN: tok });
        knobs.curl_routes = 'https://\t{ "api_domain": "https://www.zohoapis.com", "access_token": "offline-access" }\n';
      }
      await scenario({ name: "w2-b3-route-switch", seed: { ...seed, config: oldConfig }, script: flow(vendor, 6, tail), env, valid: [...validFor(vendor), tok], knobs }, async run => {
        assert.equal(run.code, 0, run.out);
        assert.match(run.out, /REMOVED_RC=3/);
        assert.match(run.out, /UNRELATED_RC=0/);
        assert.match(run.out, /UNDO_RC=0/);
        assertStateIdentical(run);
      });
    });
  }
});

it("rollback preserves concurrent native client edits and user-added files outside rotating snapshots", async () => {
  const tail = `printf 'user note\\n' > "$HOME/.hermes/skills/hstack-typeform/user-note.txt"
printf 'user edit\\n' >> "$HOME/.hermes/skills/hstack-typeform/client.py"
integration_rollback; echo "UNDO_RC=$?"
`;
  await scenario({ name: "w2-b3-concurrent-edits", seed, script: flow("typeform", 6, tail), env: fullEnv("typeform"), valid: validFor("typeform"), knobs: knobsFor("typeform") }, async run => {
    assert.match(run.out, /UNDO_RC=0/);
    assertStateIdentical(run);
    assert.ok(!run.sb.exists(".hermes/skills/hstack-typeform"));
    const saved = run.sb.ls(".hermes/.hstack-preserved/integration-typeform");
    assert.equal(saved.length, 1);
    assert.equal(run.sb.read(`.hermes/.hstack-preserved/integration-typeform/${saved[0]}/user-note.txt`), "user note\n");
    assert.match(run.sb.read(`.hermes/.hstack-preserved/integration-typeform/${saved[0]}/client.py`), /user edit/);
  });
});

it("Replicate's installed client enforces the selected exact model allowlist even with explicit write permission", async () => {
  const tail = `remote 'python3 ~/.hermes/skills/hstack-replicate/client.py /models/outside/model/predictions --method POST --allow-write'; echo "OUTSIDE_RC=$?"
remote 'python3 ~/.hermes/skills/hstack-replicate/client.py /predictions --method POST --allow-write'; echo "AMBIGUOUS_RC=$?"
remote 'python3 ~/.hermes/skills/hstack-replicate/client.py /models/allowed/model/predictions --method POST --allow-write'; echo "ALLOWED_RC=$?"
`;
  await scenario({ name: "w2-b3-model-allowlist", seed, script: flow("replicate", 8, tail), env: { ...fullEnv("replicate"), REPLICATE_ALLOWED_MODELS: "allowed/model", READ_ONLY: "0" }, valid: validFor("replicate"), knobs: knobsFor("replicate") }, async run => {
    assert.match(run.out, /OUTSIDE_RC=1/);
    assert.match(run.out, /AMBIGUOUS_RC=1/);
    assert.match(run.out, /ALLOWED_RC=0/);
    assert.ok(!run.sb.curlCalls().some(c => c.url.includes("outside/model")));
    assert.ok(run.sb.curlCalls().some(c => c.url.endsWith("/models/allowed/model/predictions")));
  });
});

it("a blank Stripe Connect selection clears its previous account scope before the installed-client smoke", async () => {
  await scenario({ name: "w2-b3-scope-clear", seed: { ...seed, env: `${seed.env}STRIPE_ACCOUNT=acct_previous\n` }, script: flow("stripe"), env: { ...fullEnv("stripe"), CONNECTOR_MODE: "rest", STRIPE_ACCOUNT: "" }, valid: validFor("stripe"), knobs: knobsFor("stripe") }, async run => {
    assert.equal(run.code, 0, run.out);
    assert.doesNotMatch(run.sb.read(".hermes/.env"), /^STRIPE_ACCOUNT=/m);
    assert.match(run.sb.read(".hermes/.hstack-backup/integration-stripe.prev/.env"), /STRIPE_ACCOUNT=acct_previous/);
    assert.ok(run.sb.hermesCalls().some(c => c.join(" ") === "config unset STRIPE_ACCOUNT"));
  });
});

for (const hasKey of [true, false]) {
  it(`Supermemory HTTPS OSS REST has consistent optional auth (key=${hasKey}), and clears a previous hosted key when omitted`, async () => {
    const env = { ...fullEnv("supermemory"), CONNECTOR_MODE: "rest", SUPERMEMORY_API_KEY: hasKey ? envs.supermemory.SUPERMEMORY_API_KEY : "" };
    const knobs = { curl_routes: 'https://\t{"memories":[]}\n', ...(hasKey ? {} : { curl_force: "1=200\n2=200\n" }) };
    await scenario({ name: "w2-b3-oss-auth", seed: { ...seed, env: `${seed.env}MCP_SUPERMEMORY_API_KEY=previous-hosted-token\n` }, script: flow("supermemory"), env, valid: validFor("supermemory"), knobs }, async run => {
      assert.equal(run.code, 0, run.out);
      assert.equal(run.sb.curlCalls().length, 2);
      if (!hasKey) assert.doesNotMatch(run.sb.read(".hermes/.env"), /^MCP_SUPERMEMORY_API_KEY=/m);
    });
  });
}

it("the actual installed client bounds oversized responses and refuses a non-private credential file", async () => {
  const tail = `cp "$HOME/oversize-route.fixture" "$HOME/knobs/curl_routes"
remote 'python3 ~/.hermes/skills/hstack-typeform/client.py'; echo "SIZE_RC=$?"
chmod 644 "$HOME/.hermes/.env"
remote 'python3 ~/.hermes/skills/hstack-typeform/client.py'; echo "PRIVATE_RC=$?"
`;
  await scenario({ name: "w2-b3-client-bound", seed, script: flow("typeform", 8, tail), env: fullEnv("typeform"), valid: validFor("typeform"), knobs: knobsFor("typeform"), setup: sb => sb.write("oversize-route.fixture", `https://\t${JSON.stringify({ data: "x".repeat(1048700) })}\n`) }, async run => {
    assert.match(run.out, /SIZE_RC=1/);
    assert.match(run.out, /PRIVATE_RC=1/);
    assert.match(run.out, /response exceeded 1 MiB/);
    assert.ok(run.sb.curlCalls().every(c => c.argv_has_token === "0"));
  });
});
