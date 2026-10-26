// Runs actual batch2 SKILL.md snippets against the offline VPS model. Vendor calls are fake.
// Catalog contracts below are verbatim bytes from the official 0.22.5 commit, not invented by the MCP stub.
import assert from "node:assert/strict";
import { readFileSync,writeFileSync,chmodSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { it,describe } from "node:test";
import { REPO_ROOT,assemble,loadBlocks,extractBlocks,skillPath } from "./helpers/blocks.mjs";
import { hermesInvocations,checkAgainstV0225 } from "./helpers/hermes-calls.mjs";
import { Sandbox,scenario,SCRIPT_END } from "./helpers/sandbox.mjs";
import { assertNoSecretInArgv,assertSecretsNotPrinted,assertStateIdentical } from "./helpers/asserts.mjs";
const PIN="bf0203a794a07aac3ff764972ab9087baa4e4f4e";
const MANIFESTS={
  "intercom": {
    "sha256": "b6181fffba6dded39846b9ce43ec9950f77a9e8af6d38f46f1bfd9111694dfa5",
    "text": "# Nous-approved MCP catalog entry.\n# Presence in this directory = approval. Merged via PR review.\nmanifest_version: 1\n\nname: intercom\nconnector_slug: intercom_mcp\ndescription: >-\n  Conversations, tickets, and customer data from Intercom.\nsource: https://developers.intercom.com/docs/guides/mcp\n\n# Official vendor-hosted remote MCP (URL-only \u2014 Hermes never spawns a local\n# process for this entry). Native OAuth 2.1 + Dynamic Client Registration;\n# Hermes's MCP client + mcp_oauth_manager handle discovery, PKCE, token\n# exchange, and refresh.\ntransport:\n  type: http\n  url: https://mcp.intercom.com/mcp\n\nauth:\n  type: oauth\n\n# Composer-suggestion triggers (desktop brand pills).\nsuggest:\n  keywords:\n    - intercom\n  hosts:\n    - intercom.com\n    - intercom.io\n\npost_install: |\n  On first connection Hermes opens a browser to authorize with\n  Intercom (or run `hermes mcp login intercom`). Approve access,\n  then restart the session so tools load.\n"
  },
  "atlassian": {
    "sha256": "bdbb7bd9da9aaa832cd620c25445c74403461a8ac8a92ad866003e9b78e54886",
    "text": "# Nous-approved MCP catalog entry.\n# Presence in this directory = approval. Merged via PR review.\nmanifest_version: 1\n\nname: atlassian\nconnector_slug: jira\ndescription: >-\n  Jira issues and Confluence pages via Atlassian's hosted remote MCP.\nsource: https://support.atlassian.com/rovo/docs/getting-started-with-the-atlassian-remote-mcp-server/\n\n# Official vendor-hosted remote MCP (URL-only \u2014 Hermes never spawns a local\n# process for this entry). Native OAuth 2.1 + Dynamic Client Registration;\n# Hermes's MCP client + mcp_oauth_manager handle discovery, PKCE, token\n# exchange, and refresh.\ntransport:\n  type: http\n  # /v1/sse was deprecated by Atlassian after June 30, 2026 (404s since the\n  # cutover \u2014 OAuth succeeded but every handshake failed; issue #91538).\n  # /v1/mcp/authv2 is the endpoint Atlassian's docs recommend for custom\n  # clients (Streamable HTTP, native OAuth 2.1 + DCR \u2014 verified live).\n  url: https://mcp.atlassian.com/v1/mcp/authv2\n\nauth:\n  type: oauth\n\n# Composer-suggestion triggers (desktop brand pills).\nsuggest:\n  keywords:\n    - jira\n    - confluence\n    - atlassian\n    - bitbucket\n  hosts:\n    - atlassian.net\n    - atlassian.com\n    - jira.com\n\npost_install: |\n  On first connection Hermes opens a browser to authorize with\n  Atlassian (or run `hermes mcp login atlassian`). Approve access,\n  then restart the session so tools load.\n"
  },
  "linear": {
    "sha256": "88d93ae81ff175952802a6cca2b72c3f1be5cd113623dae6b53a67823e44770e",
    "text": "# Nous-approved MCP catalog entry.\n# Presence in this directory = approval. Merged via PR review.\nmanifest_version: 1\n\nname: linear\nconnector_slug: linear\ndescription: Find, create, and update Linear issues, projects, and comments.\nsource: https://linear.app/docs/mcp\n\n# Linear ships a remote MCP server with native OAuth 2.1 + Dynamic Client\n# Registration over Streamable HTTP. Hermes's MCP client + mcp_oauth_manager\n# handle discovery, PKCE, token exchange, and refresh \u2014 nothing to install\n# locally.\ntransport:\n  type: http\n  url: https://mcp.linear.app/mcp\n\nauth:\n  type: oauth\n  # No `provider:` \u2014 this is native MCP OAuth (case 1), not a third-party\n  # provider like Google. The MCP client triggers the browser flow on the\n  # first probe / first connect.\n\n# Tool selection at install time:\n# Linear's MCP server exposes a moderate-sized tool surface (find/get/list +\n# create/update across issues/projects/comments). We leave `default_enabled`\n# unset so the install-time checklist starts with everything pre-checked \u2014\n# users prune what they don't want.\n#\n# If you want to encode a curated subset here once it stabilizes, list the\n# tool names under `tools.default_enabled`. Probe failure would then apply\n# that list directly.\n\n# Composer-suggestion triggers (desktop brand pills).\nsuggest:\n  keywords:\n    - linear\n  hosts:\n    - linear.app\n\npost_install: |\n  On first connection, Hermes will open a browser to authenticate with Linear.\n  After auth, restart your Hermes session so the Linear tools are loaded.\n\n  You can re-run the tool checklist any time with:\n    hermes mcp configure linear\n"
  },
  "monday": {
    "sha256": "43548c81431bf48716ce8ffefc4c9b4a4956ab7c7f4dfaaa7a80fd7301ff7069",
    "text": "# Nous-approved MCP catalog entry.\n# Presence in this directory = approval. Merged via PR review.\nmanifest_version: 1\n\nname: monday\ndescription: Boards, items, docs, and workflows in monday.com.\nsource: https://developer.monday.com/apps/docs/mondaycom-mcp-integration\n\n# Official vendor-hosted remote MCP (URL-only \u2014 Hermes never spawns a local\n# process for this entry). Native OAuth 2.1 + Dynamic Client Registration\n# (verified live: RFC 9728 protected-resource metadata -> AS metadata with\n# registration_endpoint); Hermes's MCP client + mcp_oauth_manager handle\n# discovery, PKCE, token exchange, and refresh.\n\ntransport:\n  type: http\n  url: https://mcp.monday.com/mcp\n\nauth:\n  type: oauth\n\n# Excluded: the 'Advanced API access' trio is a generic execute-any-GraphQL\n# escape hatch (meta-layer \u2014 Hermes policy: no server-side API-execute\n# indirection); get_sprint_summary is an AI-product feature;\n# create_notification pings other users' bell/email.\ntools:\n  default_excluded:\n    - all_monday_api\n    - get_graphql_schema\n    - get_type_details\n    - get_sprint_summary\n    - create_notification\n\n# Composer-suggestion triggers (desktop brand pills).\nsuggest:\n  keywords:\n    - monday.com\n    - monday board\n  hosts:\n    - monday.com\n\npost_install: |\n  On first connection Hermes opens a browser to authorize with\n  monday.com (or run `hermes mcp login monday`). Approve access,\n  then restart the session so tools load.\n"
  },
  "neon": {
    "sha256": "90c49de88394966083bb7db5374857bfdf0fdd4cc40451bb106a3eee22092340",
    "text": "# Nous-approved MCP catalog entry.\n# Presence in this directory = approval. Merged via PR review.\nmanifest_version: 1\n\nname: neon\nconnector_slug: neon_mcp\ndescription: 'Neon serverless Postgres: projects, branches, and SQL.'\nsource: https://neon.com/docs/ai/neon-mcp-server\n\n# Official vendor-hosted remote MCP (URL-only \u2014 Hermes never spawns a local\n# process for this entry). Native OAuth 2.1 + Dynamic Client Registration\n# (verified live: RFC 9728 protected-resource metadata -> AS metadata with\n# registration_endpoint); Hermes's MCP client + mcp_oauth_manager handle\n# discovery, PKCE, token exchange, and refresh.\n\ntransport:\n  type: http\n  url: https://mcp.neon.tech/mcp\n\nauth:\n  type: oauth\n\n# Excluded: search/fetch nav indirection (redundant with list/describe\n# tools); docs-lookup pair; observability beta (single-region, dead weight\n# for most); Neon Auth product provisioning trio.\ntools:\n  default_excluded:\n    - search\n    - fetch\n    - list_docs_resources\n    - get_doc_resource\n    - query_logs\n    - list_log_fields\n    - list_log_field_values\n    - provision_neon_auth\n    - configure_neon_auth\n    - get_neon_auth_config\n\n# Composer-suggestion triggers (desktop brand pills).\nsuggest:\n  keywords:\n    - neon\n    - postgres\n  hosts:\n    - neon.tech\n    - neon.com\n\npost_install: |\n  On first connection Hermes opens a browser to authorize with\n  Neon (or run `hermes mcp login neon`). Approve access,\n  then restart the session so tools load.\n"
  },
  "netlify": {
    "sha256": "b4d59996c7c7752d90d3aed679791b1b4c1b0a8c5c56dc7e56bad43a8b8e360c",
    "text": "# Nous-approved MCP catalog entry.\n# Presence in this directory = approval. Merged via PR review.\nmanifest_version: 1\n\nname: netlify\ndescription: >-\n  Sites, deploys, and env vars via Netlify's hosted MCP.\nsource: https://docs.netlify.com/build/build-with-ai/agent-setup-guides/agent-setup-overview/\n\n# Official vendor-hosted remote MCP (URL-only \u2014 Hermes never spawns a local\n# process for this entry). Native OAuth 2.1 + Dynamic Client Registration;\n# Hermes's MCP client + mcp_oauth_manager handle discovery, PKCE, token\n# exchange, and refresh.\n# No `netlify.app` suggest host for the same deploy-preview reason as vercel.app.\ntransport:\n  type: http\n  url: https://netlify-mcp.netlify.app/mcp\n\nauth:\n  type: oauth\n\n# Composer-suggestion triggers (desktop brand pills).\nsuggest:\n  keywords:\n    - netlify\n  hosts:\n    - netlify.com\n\npost_install: |\n  On first connection Hermes opens a browser to authorize with\n  Netlify (or run `hermes mcp login netlify`). Approve access,\n  then restart the session so tools load.\n"
  },
  "paypal": {
    "sha256": "2c3fc4b70266d419bd0efb3bc469f2c1b28fa39b842d86dc9e2bea7da2617776",
    "text": "# Nous-approved MCP catalog entry.\n# Presence in this directory = approval. Merged via PR review.\nmanifest_version: 1\n\nname: paypal\ndescription: >-\n  Payments, invoices, and subscriptions via PayPal's hosted MCP.\nsource: https://developer.paypal.com/tools/mcp-server/\n\n# Official vendor-hosted remote MCP (URL-only \u2014 Hermes never spawns a local\n# process for this entry). Native OAuth 2.1 + Dynamic Client Registration;\n# Hermes's MCP client + mcp_oauth_manager handle discovery, PKCE, token\n# exchange, and refresh.\ntransport:\n  type: http\n  url: https://mcp.paypal.com/sse\n\nauth:\n  type: oauth\n\n# Composer-suggestion triggers (desktop brand pills).\nsuggest:\n  keywords:\n    - paypal\n  hosts:\n    - developer.paypal.com\n\npost_install: |\n  On first connection Hermes opens a browser to authorize with\n  Paypal (or run `hermes mcp login paypal`). Approve access,\n  then restart the session so tools load.\n"
  },
  "railway": {
    "sha256": "ecd5ad7082e410379af9f26647bf0f83776d51e39af644d288bd90a99c4ea81b",
    "text": "# Nous-approved MCP catalog entry.\n# Presence in this directory = approval. Merged via PR review.\nmanifest_version: 1\n\nname: railway\nconnector_slug: railway\ndescription: 'Railway: projects, services, deployments, and environments.'\nsource: https://docs.railway.com/guides/mcp-server\n\n# Official vendor-hosted remote MCP (URL-only \u2014 Hermes never spawns a local\n# process for this entry). Native OAuth 2.1 + Dynamic Client Registration\n# (verified live: RFC 9728 protected-resource metadata -> AS metadata with\n# registration_endpoint); Hermes's MCP client + mcp_oauth_manager handle\n# discovery, PKCE, token exchange, and refresh.\ntransport:\n  type: http\n  url: https://mcp.railway.com\n\nauth:\n  type: oauth\n\n# Excluded: railway-agent hands the request to Railway's server-side AI\n# agent for multi-step infra operations \u2014 an opaque delegation meta-layer\n# that acts outside Hermes's per-tool approval loop. The remaining tools\n# are direct (and destructive ones carry vendor destructive-hints).\ntools:\n  default_excluded:\n    - railway-agent\n\n# Composer-suggestion triggers (desktop brand pills).\nsuggest:\n  keywords:\n    - railway\n    - railway deploy\n  hosts:\n    - railway.com\n    - railway.app\n\npost_install: |\n  On first connection Hermes opens a browser to authorize with\n  Railway (or run `hermes mcp login railway`). Approve access,\n  then restart the session so tools load.\n"
  }
};
const NAMES="hubspot intercom jira linear mailchimp mem0 microsoft-365 monday neon netlify openai-tools paypal pinecone pipedrive postgres posthog postmark qdrant r2 railway razorpay redis render".split(" ");
const CATALOG={intercom:"intercom",jira:"atlassian",linear:"linear",monday:"monday",neon:"neon",netlify:"netlify",paypal:"paypal",railway:"railway"};
const token=["offline","batch2","fixture"].join("-");
const SEED={env:"UNRELATED=preserve\n",config:"model: existing\n"};
const blocks=(name)=>loadBlocks("integration-"+name);
const full=(name,extra="")=>assemble(["set +e\n",{skill:"integration-"+name,ids:blocks(name).map(b=>b.id)},extra,SCRIPT_END]);
const selected=(name,ids,extra="")=>assemble(["set +e\n",{skill:"integration-"+name,ids},extra,SCRIPT_END]);
const envs={hubspot:{HUBSPOT_ACCESS_TOKEN:token},intercom:{INTERCOM_TOKEN:token,INTERCOM_REGION:"us"},jira:{JIRA_TOKEN:token,ATLASSIAN_EMAIL:"agent@example.invalid",JIRA_SITE:"https://example.atlassian.net"},linear:{LINEAR_API_KEY:token},mailchimp:{MC_KEY:token+"-us21"},mem0:{MEM0_API_KEY:token},"microsoft-365":{MS365_CLIENT_SECRET:token,MS365_CLIENT_ID:"00000000-0000-0000-0000-000000000001",MS365_TENANT_ID:"00000000-0000-0000-0000-000000000002",MS365_ADMIN_CONSENT_ACKNOWLEDGED:"1"},monday:{MONDAY_TOKEN:token},neon:{NEON_API_KEY:token},netlify:{NETLIFY_TOKEN:token},"openai-tools":{OPENAI_TOOLS_API_KEY:token},paypal:{PP_CLIENT_ID:"offline-client",PP_SECRET:token,PP_ENV:"LIVE",PROD_ACKNOWLEDGED:"1"},pinecone:{PINECONE_API_KEY:token},pipedrive:{PIPEDRIVE_API_TOKEN:token,PIPEDRIVE_COMPANY_DOMAIN:"example"},postgres:{POSTGRES_URL:"postgres://reader:offline@db.example.invalid/app"},posthog:{POSTHOG_API_KEY:token},postmark:{POSTMARK_SERVER_TOKEN:token},qdrant:{QDRANT_API_KEY:token,QDRANT_URL:"https://example.invalid"},r2:{R2_ACCOUNT_ID:"a".repeat(32),R2_ACCESS_KEY_ID:"offline-access",R2_SECRET_ACCESS_KEY:token,R2_BUCKET_NAME:"offline-bucket"},railway:{RAILWAY_API_TOKEN:token},razorpay:{RZP_KEY_ID:"rzp_test_offline",RZP_KEY_SECRET:token},redis:{REDIS_URL:"redis://reader:offline@db.example.invalid/0"},render:{RENDER_API_KEY:token}};

describe("wave2 batch2 pinned source and syntax",()=>{
 it("all 23 skills use parseable Bash and real pinned Hermes argv, without legacy interfaces",()=>{
  const calls=[];
  for(const name of NAMES){
   const md=readFileSync(skillPath("integration-"+name),"utf8");
   assert.match(md,new RegExp(PIN));
   assert.doesNotMatch(md,/gateway run --daemon|--auth-header|--auth-scheme|--placeholder-token|--rest-base|--auth-env|legacy procedure/);
   for(const b of extractBlocks(md)){const p=spawnSync("/bin/bash",["-n"],{input:b.code,encoding:"utf8"});assert.equal(p.status,0,`${name} ${b.id}: ${p.stderr}`);}
   calls.push(...hermesInvocations(md));
  }
  const invalid=checkAgainstV0225(calls).filter(r=>r.code);assert.deepEqual(invalid,[]);
 });
 it("catalog routes match the actual pinned upstream manifests, including Jira authv2 and vendor OAuth",()=>{
  for(const [name,entry] of Object.entries(CATALOG)){
   const m=MANIFESTS[entry];assert.equal(createHash("sha256").update(m.text).digest("hex"),m.sha256);
   assert.match(m.text,/auth:\n  type: oauth/);
   const md=readFileSync(skillPath("integration-"+name),"utf8");assert.ok(md.includes(`hermes -p default mcp install ${entry}`));assert.ok(md.includes(`hermes -p default mcp login ${entry}`));
   // Optional local source evidence check: never fetch a moving branch or access the user's installed Hermes.
   if(process.env.HSTACK_HERMES_SOURCE_ROOT) assert.equal(readFileSync(path.join(process.env.HSTACK_HERMES_SOURCE_ROOT,"optional-mcps",entry,"manifest.yaml"),"utf8"),m.text);
  }
  assert.match(MANIFESTS.atlassian.text,/https:\/\/mcp[.]atlassian[.]com\/v1\/mcp\/authv2/);
  assert.match(MANIFESTS.monday.text,/create_notification/);assert.match(MANIFESTS.railway.text,/railway-agent/);
 });
 it("all installed runtime Python programs compile",()=>{
  for(const name of NAMES){const md=readFileSync(skillPath("integration-"+name),"utf8");const code=/python3 - <<'PYTHON'\n([\s\S]*?)\nPYTHON/.exec(md)?.[1];if(!code)continue;
   const r=spawnSync("python3",["-c","import sys; compile(sys.stdin.read(), '<native-skill>', 'exec')"],{input:code,encoding:"utf8"});assert.equal(r.status,0,`${name}: ${r.stderr}`);
   assert.match(code,/stat[.]S_IMODE/);if(code.includes("request_json"))assert.match(code,/NoRedirect/);
  }
 });
});

describe("wave2 batch2 actual remote snippets",{concurrency:4},()=>{
 for(const name of ["hubspot","linear","monday","neon","netlify","railway","posthog","render","mem0","pinecone","postmark","qdrant","openai-tools","pipedrive"]){
  it(`${name}: real setup snippets preserve unrelated bytes and require native discovery/readiness`,async()=>{
   await scenario({name:"w2-b2-"+name,seed:SEED,script:full(name),env:envs[name],valid:[token],knobs:{mcp_oauth_ok:true}},async(run)=>{
    assert.equal(run.code,0,run.out);assert.ok(run.completed);assert.equal(run.sb.mode(".hermes/.env"),0o600);
    assert.ok(run.sb.read(".hermes/.env").includes("UNRELATED=preserve"));assert.equal(run.sb.read(`.hermes/.hstack-backup/integration-${name}.prev/.env`),SEED.env);
    assertNoSecretInArgv(run,[token]);assertSecretsNotPrinted(run,[token]);
    if(CATALOG[name]||["posthog","render","mem0"].includes(name))assert.ok(run.sb.hermesCalls().some(c=>c[0]==="mcp"&&c[1]==="test"));
    else assert.ok(run.sb.exists(`.hermes/skills/integration-${name}-runtime/SKILL.md`));
   });
  });
 }
 for(const name of ["intercom","jira","paypal","mailchimp","razorpay"]){
  it(`${name}: native route completes with modeled vendor auth and consent`,async()=>{
   const knobs={mcp_oauth_ok:true};

   if(name==="paypal"){knobs.curl_routes='oauth2/token\t{"access_token":"offline-access","expires_in":3600}\n';}
   await scenario({name:"w2-b2-route-"+name,seed:SEED,script:full(name),env:envs[name],valid:[token,Buffer.from(`agent@example.invalid:${token}`).toString("base64"),Buffer.from(`hstack:${token}-us21`).toString("base64"),Buffer.from(`rzp_test_offline:${token}`).toString("base64"),Buffer.from(`offline-client:${token}`).toString("base64")],knobs},async(run)=>{
    assert.equal(run.code,0,run.out);assert.ok(run.completed);assertNoSecretInArgv(run,[token]);assertSecretsNotPrinted(run,[token]);
    if(CATALOG[name])assert.ok(run.sb.hermesCalls().some(c=>c[0]==="mcp"&&c[1]==="install"&&c[2]===CATALOG[name]));
    else if(name==="razorpay")assert.match(run.sb.read(".hermes/config.yaml"),/Basic/);
    else assert.ok(run.sb.exists(`.hermes/skills/integration-${name}-runtime/SKILL.md`));
   });
  });
 }
 it("a repeated owned native-skill setup is idempotent and preserves its recovery point",async()=>{
  await scenario({name:"w2-b2-repeat",seed:SEED,script:full("hubspot"),env:envs.hubspot,valid:[token]},async(run)=>{
   assert.equal(run.code,0,run.out);const before=run.sb.state();const previous=run.sb.read(".hermes/.hstack-backup/integration-hubspot.prev/native.cksum");
   const repeat=await run.sb.run(full("hubspot"),{env:envs.hubspot});assert.equal(repeat.code,0,repeat.out);assert.match(repeat.out,/unchanged and discoverable/);assert.deepEqual(run.sb.state(),before);assert.equal(run.sb.read(".hermes/.hstack-backup/integration-hubspot.prev/native.cksum"),previous);
  });
 });
 for(const name of ["microsoft-365","r2","postgres","redis"]){
  it(`${name}: executable host dependency preflight and native skill complete`,async()=>{
   await scenario({name:"w2-b2-dep-"+name,seed:SEED,script:full(name),env:envs[name],valid:[token,"fake-bot-framework-token"],setup(sb){
    if(name==="r2")sb.write("remote_bin/aws",'#!/bin/bash\n[ "$AWS_ACCESS_KEY_ID" = offline-access ] && [ "$AWS_SECRET_ACCESS_KEY" = offline-batch2-fixture ] || exit 9\nprintf "{\\"objects\\":[]}\\n"\n',0o755);
    if(name==="postgres"||name==="redis"){
     sb.write("remote_bin/python3",'#!/bin/bash\nexport PYTHONPATH="$HOME/fixtures"\nexec /usr/bin/python3 "$@"\n',0o755);
     if(name==="postgres")sb.write("fixtures/psycopg.py",'class Cursor:\n def __init__(self,c): self.c=c\n def __enter__(self): return self\n def __exit__(self,*a): pass\n def execute(self,q):\n  assert self.c.read_only, "probe must be a read-only transaction"\n  assert q in ("SELECT 1","SELECT current_user, current_database()")\n  self.q=q\n def fetchone(self): return (1,) if self.q=="SELECT 1" else ("reader","app")\nclass Connection:\n read_only=False\n def __enter__(self): return self\n def __exit__(self,*a): pass\n def cursor(self): return Cursor(self)\ndef connect(uri,connect_timeout):\n assert uri=="postgres://reader:offline@db.example.invalid/app"\n assert connect_timeout==10\n return Connection()\n');
     else sb.write("fixtures/redis.py",'class Client:\n def ping(self): return True\ndef from_url(uri,**kwargs):\n assert uri=="redis://reader:offline@db.example.invalid/0"\n assert kwargs.get("socket_timeout")==10\n return Client()\n');
    }
   }},async(run)=>{assert.equal(run.code,0,run.out);assert.ok(run.sb.exists(`.hermes/skills/integration-${name}-runtime/SKILL.md`));assertNoSecretInArgv(run,[token]);assertSecretsNotPrinted(run,[token]);
    if(["postgres","redis","r2"].includes(name)){
     const native=run.sb.read(`.hermes/skills/integration-${name}-runtime/SKILL.md`);const body=/~~~bash\n([\s\S]*?)\n~~~/.exec(native)[1];
     const r=await run.sb.run('export PATH="$HOME/remote_bin:$PATH"\n'+body);assert.equal(r.code,0,r.out);
    }
   });
  });
 }
 for(const [name,env] of [["intercom",{...envs.intercom,INTERCOM_REGION:"eu"}],["paypal",{...envs.paypal,PP_ENV:"SANDBOX"}]]){
  it(`${name}: noncatalog region/environment publishes the real native API skill`,async()=>{
   const knobs=name==="paypal"?{curl_routes:'oauth2/token\t{"access_token":"offline-access","expires_in":3600}\n'}:{};
   await scenario({name:"w2-b2-branch-"+name,seed:SEED,script:full(name),env,valid:[token,Buffer.from(`offline-client:${token}`).toString("base64")],knobs},async(run)=>{assert.equal(run.code,0,run.out);assert.ok(run.sb.exists(`.hermes/skills/integration-${name}-runtime/SKILL.md`));assert.ok(!run.sb.hermesCalls().some(c=>c[0]==="mcp"&&c[1]==="install"));});
  });
 }
 for(const [name,changed] of [["mem0",{WIRE_PATH:"B",MEM0_HOST:"http://127.0.0.1:8888"}],["intercom",{INTERCOM_REGION:"eu"}],["paypal",{PP_ENV:"SANDBOX"}]]){
  it(`${name}: selected REST route retires a healthy previous MCP transactionally instead of skipping`,async()=>{
   const knobs={mcp_oauth_ok:true};if(name==="paypal")knobs.curl_routes='oauth2/token\t{"access_token":"offline-access","expires_in":3600}\n';
   await scenario({name:"w2-b2-switch-"+name,seed:SEED,script:full(name),env:envs[name],valid:[token,Buffer.from(`offline-client:${token}`).toString("base64")],knobs},async(run)=>{
    assert.equal(run.code,0,run.out);assert.ok(run.sb.read(".hermes/config.yaml").includes(`mcp.${name}:`));
    const r=await run.sb.run(full(name),{env:{...envs[name],...changed}});assert.equal(r.code,0,r.out);assert.match(r.out,/Setup complete/);
    assert.ok(!run.sb.read(".hermes/config.yaml").includes(`mcp.${name}:`));assert.ok(run.sb.exists(`.hermes/skills/integration-${name}-runtime/SKILL.md`));
    assertNoSecretInArgv({...run,out:r.out},[token]);
   });
  });
 }
 it("failed Mem0 hosted-to-OSS migration restores the previously healthy hosted connector",async()=>{
  await scenario({name:"w2-b2-switch-undo",seed:SEED,script:full("mem0"),env:envs.mem0,valid:[token]},async(run)=>{
   assert.equal(run.code,0,run.out);const before=run.sb.state();
   const script=selected("mem0",["step0#1","step1#1","step2#1","step3#1","step4#1","step5#1","step6#1"], 'fail_change "injected after mode change"');
   const r=await run.sb.run(script,{env:{WIRE_PATH:"B",MEM0_HOST:"http://127.0.0.1:8888",FORCE:"1"}});assert.equal(r.code,1,r.out);assert.deepEqual(run.sb.state(),before);assert.ok(run.sb.read(".hermes/config.yaml").includes("mcp.mem0:"));assert.ok(!run.sb.exists(".hermes/skills/integration-mem0-runtime"));
  });
 });
 it("invalid credentials abort before snapshot and writes",async()=>{
  await scenario({name:"w2-b2-reject",seed:SEED,script:full("hubspot"),env:envs.hubspot},async(run)=>{assert.equal(run.code,1,run.out);assertStateIdentical(run);assert.ok(!run.sb.exists(".hermes/.hstack-backup"));});
 });
 it("dry run exits before snapshot and publication",async()=>{
  await scenario({name:"w2-b2-dry",seed:SEED,script:full("hubspot"),env:{...envs.hubspot,DRY_RUN:"1"},valid:[token]},async(run)=>{assert.equal(run.code,0,run.out);assertStateIdentical(run);assert.ok(!run.sb.exists(".hermes/.hstack-backup"));});
 });
 it("HTTP200 GraphQL errors are a failed credential gate",async()=>{
  await scenario({name:"w2-b2-graphql",seed:SEED,script:full("linear"),env:envs.linear,valid:[token],knobs:{curl_routes:'api.linear.app\t{"errors":[{"message":"denied"}]}\n' }},async(run)=>{assert.equal(run.code,1,run.out);assertStateIdentical(run);assert.ok(!run.sb.exists(".hermes/.hstack-backup"));});
 });
 it("OAuth login exit0 without credentials fails native test and restores old config",async()=>{
  await scenario({name:"w2-b2-oauth",seed:SEED,script:full("linear"),env:envs.linear,valid:[token]},async(run)=>{assert.equal(run.code,1,run.out);assertStateIdentical(run);assert.ok(!run.completed);});
 });
 it("a user-owned native skill is preserved before any writes",async()=>{
  const rel=".hermes/skills/integration-hubspot-runtime/SKILL.md";
  await scenario({name:"w2-b2-owned",seed:SEED,script:full("hubspot"),env:envs.hubspot,valid:[token],files:{[rel]:"user-owned\n"}},async(run)=>{assert.equal(run.code,1,run.out);assert.equal(run.sb.read(rel),"user-owned\n");assertStateIdentical(run);assert.ok(!run.sb.exists(".hermes/.hstack-backup"));});
 });
 it("post-publication failure removes only the created skill and restores exact bytes",async()=>{
  const script=selected("hubspot",["step0#1","step1#1","step2#1","step3#1","step4#1","step5#1","step6#1"], 'fail_change "injected after publication"');
  await scenario({name:"w2-b2-clean",seed:SEED,script,env:envs.hubspot,valid:[token]},async(run)=>{assert.equal(run.code,1,run.out);assertStateIdentical(run);assert.ok(!run.sb.exists(".hermes/skills/integration-hubspot-runtime"));assert.ok(run.sb.exists(".hermes/.hstack-backup/integration-hubspot.prev"));});
 });
 it("edited runtime file is kept and its active recovery point retained",async()=>{
  const script=selected("hubspot",["step0#1","step1#1","step2#1","step3#1","step4#1","step5#1","step6#1"], 'printf "user edit\n" >> "$HOME/.hermes/skills/integration-hubspot-runtime/SKILL.md"\nfail_change "injected after external edit"');
  await scenario({name:"w2-b2-edit",seed:SEED,script,env:envs.hubspot,valid:[token]},async(run)=>{assert.equal(run.code,1,run.out);assert.match(run.sb.read(".hermes/skills/integration-hubspot-runtime/SKILL.md"),/user edit/);assert.ok(run.sb.exists(".hermes/.hstack-backup/integration-hubspot/.complete"));});
 });
 it("Mem0 OSS uses a real published search skill without a hosted key or mutating smoke",async()=>{
  await scenario({name:"w2-b2-mem0-oss",seed:SEED,script:full("mem0"),env:{WIRE_PATH:"B",MEM0_HOST:"http://127.0.0.1:8888"}},async(run)=>{assert.equal(run.code,0,run.out);assert.ok(run.sb.exists(".hermes/skills/integration-mem0-runtime/SKILL.md"));assert.ok(!run.sb.hermesCalls().some(c=>c[0]==="mcp"&&c[1]==="add"));assert.ok(run.sb.curlCalls().every(c=>c.url.endsWith("/search")));});
 });
 for(const [name,url] of [["postgres","postgres://postgres:offline@db.example.invalid/app"],["redis","redis://default:offline@db.example.invalid/0"]]){
  it(`${name}: privileged user refuses before any write`,async()=>{await scenario({name:"w2-b2-priv-"+name,seed:SEED,script:full(name),env:{[name==="postgres"?"POSTGRES_URL":"REDIS_URL"]:url}},async(run)=>{assert.equal(run.code,1,run.out);assertStateIdentical(run);assert.ok(!run.sb.exists(".hermes/.hstack-backup"));});});
 }
});

// Executes the code that was actually installed by the real skill block, against a bounded loopback fixture.
it("installed runtime skill reads data, blocks credential redirects, oversized bodies and nonprivate env",async()=>{
 const sb=new Sandbox("w2-b2-runtime");let forwarded=0;
 const server=createServer((req,res)=>{if(req.url==="/redirect") {res.writeHead(302,{Location:`http://127.0.0.1:${server.address().port}/stolen`});res.end();}else if(req.url==="/stolen"){forwarded++;res.end("{}");}else if(req.url==="/huge"){res.end("x".repeat(1048577));}else {assert.equal(req.headers.authorization,"Bearer "+token);res.setHeader("Content-Type","application/json");res.end('{"contacts":[{"id":"fixture-1"}]}');}});
 try{
  sb.seed(SEED).validTokens([token]);const setup=await sb.run(full("hubspot"),{env:envs.hubspot});assert.equal(setup.code,0,setup.out);
  const installed=sb.read(".hermes/skills/integration-hubspot-runtime/SKILL.md");const body=/~~~bash\n([\s\S]*?)\n~~~/.exec(installed)[1];
  server.listen(0,"127.0.0.1");await once(server,"listening");const base=`http://127.0.0.1:${server.address().port}`;
  const original="https://api.hubapi.com/crm/v3/objects/contacts?limit=1";
  let r=await sb.run(body.replace(original,base+"/read"));assert.equal(r.code,0,r.out);assert.match(r.out,/fixture-1/);
  r=await sb.run(body.replace(original,base+"/redirect"));assert.notEqual(r.code,0);assert.equal(forwarded,0,"Authorization must never follow a redirect");assert.ok(!r.out.includes(token));
  r=await sb.run(body.replace(original,base+"/huge"));assert.notEqual(r.code,0);assert.ok(!r.out.includes(token));
  chmodSync(sb.p(".hermes/.env"),0o644);r=await sb.run(body.replace(original,base+"/read"));assert.notEqual(r.code,0);assert.match(r.out,/private regular file/);
 }finally{server.close();sb.cleanup();}
});

// A user curlrc must not enable redirect-following or replace credential request options.
it('every shared credential probe disables curlrc before processing options', () => {
  for (const name of ['hubspot','intercom','jira','linear','mailchimp','mem0','microsoft-365','monday','neon','netlify','openai-tools','paypal','pinecone','pipedrive','postgres','posthog','postmark','qdrant','r2','railway','razorpay','redis','render']) {
    assert.match(readFileSync(skillPath(`integration-${name}`), 'utf8'), /remote 'curl -q -fsS --connect-timeout/);
  }
});
