// Exercises migrated catalogue / stdio / HTTP registration and actual installed native clients.
// The transport is a local sandbox, not live Hermes/vendor evidence.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { assemble, loadBlocks, skillPath } from './helpers/blocks.mjs';
import { scenario, SCRIPT_END } from './helpers/sandbox.mjs';

const catalog = ['airtable','asana','calendly','clickup','cloudflare','datadog','gitlab'];
const stdio = ['aws','azure','brave-search','e2b','elevenlabs'];
const http = ['brevo','digitalocean','exa','firecrawl','freshdesk'];
const local = ['auth0','bitbucket','clerk','hetzner','gcp'];
const all = [...catalog,...stdio,...http,...local,'google-workspace'];
const env = {
 VPS_USER:'root',VPS_IP:'vps.example.invalid',FORCE:'1',OAUTH_ACKNOWLEDGED:'1',WRITES_ACKNOWLEDGED:'1',
 ASANA_CLIENT_ID:'test-app-id',ASANA_CLIENT_SECRET:'test-asana-secret',AUTH0_DOMAIN:'example.auth0.com',AUTH0_CLIENT_ID:'test-client',AUTH0_CLIENT_SECRET:'test-auth0-secret',
 AWS_ACCESS_KEY_ID:'AKIA'+'N'.repeat(16),AWS_SECRET_ACCESS_KEY:'N'.repeat(40),AWS_SESSION_TOKEN:'',AWS_REGION:'us-east-1',
 AZURE_TENANT_ID:'00000000-0000-0000-0000-000000000001',AZURE_CLIENT_ID:'00000000-0000-0000-0000-000000000002',AZURE_CLIENT_SECRET:'test-azure-secret',
 BRAVE_API_KEY:'test-brave-secret',E2B_API_KEY:'e2b_'+'N'.repeat(32),ELEVENLABS_API_KEY:'test-elevenlabs-secret',MCP_BREVO_API_KEY:'test-brevo-secret',
 DO_TOKEN:'dop_v1_'+'N'.repeat(64),DO_SERVICE:'droplets',EXA_API_KEY:'test-exa-secret',FIRECRAWL_API_KEY:'fc-'+'N'.repeat(40),
 FRESHDESK_DOMAIN:'example',FRESHDESK_API_KEY:'test-freshdesk-secret',BITBUCKET_AUTH:'Basic ZXhhbXBsZTpleGFtcGxl',
 CLERK_SECRET_KEY:'sk_test_'+'N'.repeat(40),HETZNER_API_TOKEN:'N'.repeat(64),GCP_PROJECT:'example-project',
};
const part=(n,ids)=>({skill:`integration-${n}`,ids});
const script=(n,tail='')=>assemble([
 'set +e\n',part(n,local.includes(n)||catalog.includes(n)?['step0#1','step0#2']:['step0#1']),
 catalog.includes(n)||stdio.includes(n)||http.includes(n)?part(n,['step2#1']):'',
 part(n,['step5#1','step6#1']),tail,SCRIPT_END,
]);

for(const n of all) it(`${n}: all actual bash snippets parse on stock bash`,()=>{
 for(const b of loadBlocks(`integration-${n}`)) {
  const r=spawnSync('/bin/bash',['-n'],{input:b.code,encoding:'utf8'});
  assert.equal(r.status,0,`${n} ${b.id}: ${r.stderr}`);
 }
 const md=readFileSync(skillPath(`integration-${n}`),'utf8');
 assert.doesNotMatch(md,/legacy procedure|gateway run --daemon|--auth-header|--args '-y,/);
 assert.ok(md.includes("v?0[.]22[.]5([[:space:]]|$)"));
});

for(const n of [...catalog,...stdio,...http,...local]) describe(`${n}: actual registration`,()=>{
 it('persists enabled native registration or a discoverable owned skill',async()=>{
  await scenario({name:`wave2-b1-${n}`,env,script:script(n)},r=>{
   assert.equal(r.code,0,r.out);assert.ok(r.completed,r.out);
   if(local.includes(n)) {
    assert.match(r.sb.read(`.hermes/skills/hstack-${n}/SKILL.md`),new RegExp(`name: hstack-${n}`));
    assert.equal(r.sb.mode(`.hermes/skills/hstack-${n}/SKILL.md`),0o600);
    assert.ok(r.sb.read(`.hermes/skills/hstack-${n}/.hstack-managed`));
   } else {
    const cfg=r.sb.read('.hermes/config.yaml');assert.match(cfg,/enabled: true/);
    if(stdio.includes(n)) assert.ok(r.sb.hermesCalls().some(x=>x[0]==='mcp'&&x[1]==='add'&&x.includes('--args')));
   }
   for(const v of [env.AWS_SECRET_ACCESS_KEY,env.AUTH0_CLIENT_SECRET,env.ELEVENLABS_API_KEY,env.EXA_API_KEY]) assert.ok(!r.out.includes(v));
  });
 });
 it('a verification failure restores previous credential/config bytes and extra owned files',async()=>{
  const oldEnv='KEEP=old\n'; const oldCfg='model.default: before\n';
  const tail=catalog.includes(n)?'extra_restore && rollback\n':local.includes(n)?'extra_restore && rollback\n':'rollback\n';
  await scenario({name:`wave2-b1-${n}-rollback`,env,seed:{env:oldEnv,config:oldCfg},script:script(n,tail)},r=>{
   assert.equal(r.code,0,r.out);assert.ok(r.completed,r.out);
   assert.equal(r.sb.read('.hermes/.env'),oldEnv);assert.equal(r.sb.read('.hermes/config.yaml'),oldCfg);
   if(local.includes(n)) assert.equal(r.sb.read(`.hermes/skills/hstack-${n}/SKILL.md`),null);
  });
 });
});

for(const n of catalog) it(`${n}: install exit 0 cannot bypass a failed OAuth connection`,async()=>{
 await scenario({name:`wave2-b1-${n}-oauth-fail`,env,seed:{env:'KEEP=old\n',config:'model.default: old\n'},script:script(n,assemble([part(n,['step7#1'])]))},r=>{
  assert.equal(r.code,1,r.out);assert.equal(r.sb.read('.hermes/.env'),'KEEP=old\n');assert.equal(r.sb.read('.hermes/config.yaml'),'model.default: old\n');
 });
});

// Read each client directly from the installed heredoc, shell-decode python -c, then execute it
// with a no-network opener. Assert the actual Authorization headers and fixed read endpoints.
for(const n of local) it(`${n}: the installed native client executes the expected read-only request`,async()=>{
 await scenario({name:`wave2-b1-${n}-client`,env,script:script(n)},r=>{
  assert.equal(r.code,0,r.out);
  const installed=r.sb.read(`.hermes/skills/hstack-${n}/SKILL.md`);
  const cmd=installed.split('\n').filter(l=>l.startsWith('    ')).map(l=>l.slice(4)).join('\n');
  const shim=`import sys, shlex, os, json, urllib.request, subprocess\ncmd=shlex.split(sys.stdin.read())\nassert cmd[:2]==['python3','-c']\ncode=cmd[2]\ncalls=[]\nclass Response:\n status=200\n def __enter__(self): return self\n def __exit__(self,*a): pass\n def read(self,n): return b'{"access_token":"test-access","items":[]}'\nclass Opener:\n def open(self,req,timeout):\n  calls.append((req.full_url,req.get_method(),dict(req.header_items())))\n  return Response()\nurllib.request.build_opener=lambda *a:Opener()\nclass Done:\n returncode=0\n stdout=b'{"projectId":"example-project"}'\ndef run(argv,**kw):\n assert argv[:3]==['gcloud','projects','describe']\n calls.append((argv[0],'READ',{}));return Done()\nsubprocess.run=run\nexec(compile(code,'installed-native-client','exec'))\nassert calls\nif ${JSON.stringify(n)}=='auth0':\n assert len(calls)==2 and calls[0][1]=='POST' and calls[1][1]=='GET'\n assert calls[1][2]['Authorization']=='Bearer test-access'\nelif ${JSON.stringify(n)}=='gcp': assert calls[0][0]=='gcloud'\nelse:\n assert calls[0][1]=='GET'\n assert calls[0][0].startswith(${JSON.stringify(n==='clerk'?'https://api.clerk.com/':n==='hetzner'?'https://api.hetzner.cloud/':'https://api.bitbucket.org/')})\nprint('CLIENT-VERIFIED')\n`;
  const out=spawnSync('python3',['-c',shim],{input:cmd,encoding:'utf8',env:{...process.env,HOME:r.sb.home}});
  assert.equal(out.status,0,out.stderr);assert.match(out.stdout,/CLIENT-VERIFIED/);
 });
});

for(const n of [...stdio,...http,...local]) it(`${n}: real preflight client has valid Python, credentials on stdin, and a bounded HTTPS read`,async()=>{
 const capture='remote() { case "$1" in python3*) printf \'%s\' "$1" > "$HOME/captured-probe" ;; esac; cat >/dev/null; return 0; }\n';
 await scenario({name:`wave2-b1-${n}-preflight`,env:{...env,BILLING_ACKNOWLEDGED:'1'},script:assemble([part(n,local.includes(n)?['step0#1','step0#2']:['step0#1']),capture,n==='digitalocean'?part(n,['step2#1']):'',part(n,['step3#1']),SCRIPT_END])},r=>{
  assert.equal(r.code,0,r.out);assert.ok(r.completed,r.out);
  const command=r.sb.read('captured-probe');assert.ok(command);
  // Values are passed to the actual parser exactly in its declared zip order.
  const vars=n==='digitalocean'?['MCP_DIGITALOCEAN_API_KEY']:[...loadBlocks(`integration-${n}`).find(x=>x.id==='step5#1').code.matchAll(/^put_env ([A-Z0-9_]+) /gm)].map(m=>m[1]).filter(x=>x!=='AZURE_TOKEN_CREDENTIALS');
  const values=vars.map(k=>(k==='MCP_DIGITALOCEAN_API_KEY'?env.DO_TOKEN:env[k])??'');
  const shim=`import shlex,sys,io,json,urllib.request,subprocess\ncode=shlex.split(${JSON.stringify(command)})[2]\ncompile(code,'preflight','exec')\nsys.stdin=io.StringIO(${JSON.stringify(values.join('\n')+'\n')})\ncalls=[]\nclass Response:\n status=200\n def __enter__(self): return self\n def __exit__(self,*a): pass\n def read(self,n):\n  assert n<=2*1024*1024+1\n  return b'{"access_token":"test-access","result":{"tools":[]}}'\nclass Opener:\n def open(self,req,timeout):\n  assert req.full_url.startswith('https://') and timeout<=30\n  calls.append((req.full_url,req.get_method(),dict(req.header_items())));return Response()\nurllib.request.build_opener=lambda *a:Opener()\nclass Done:\n returncode=0\n stdout=b'{}'\ndef run(argv,**kw):\n assert argv[:2] in (['aws','sts'],['gcloud','projects'])\n calls.append((argv[0],'READ',{}));return Done()\nsubprocess.run=run\nexec(code)\nassert calls\nif ${JSON.stringify(n)}=='e2b': assert calls[0][2]['X-api-key']==${JSON.stringify(env.E2B_API_KEY)}\nprint('PREFLIGHT-VERIFIED')\n`;
  const result=spawnSync('python3',['-c',shim],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/PREFLIGHT-VERIFIED/);
 });
});

for(const n of [...stdio,...http,...local]) it(`${n}: an empty credential aborts before any remote write`,async()=>{
 const noCredentials={VPS_USER:'root',VPS_IP:'vps.example.invalid',BILLING_ACKNOWLEDGED:'1'};
 await scenario({name:`wave2-b1-${n}-empty`,env:noCredentials,script:assemble([part(n,local.includes(n)?['step0#1','step0#2']:['step0#1']),part(n,['step3#1']),SCRIPT_END])},r=>{
  assert.equal(r.code,1,r.out);assert.ok(!r.completed);assert.match(r.out,/ABORT:.*Nothing was written/);
  assert.equal(r.sb.read('.hermes/.env'),null);assert.equal(r.sb.read('.hermes/config.yaml'),null);
 });
});

for(const n of [...stdio,...http]) it(`${n}: failed MCP health check takes the real rollback path`,async()=>{
 await scenario({name:`wave2-b1-${n}-test-fail`,env,seed:{env:'KEEP=old\n',config:'model.default: before\n'},knobs:{'fail.mcp.test':true},script:script(n,assemble([part(n,['step7#1'])]))},r=>{
  assert.equal(r.code,1,r.out);assert.equal(r.sb.read('.hermes/.env'),'KEEP=old\n');assert.equal(r.sb.read('.hermes/config.yaml'),'model.default: before\n');
 });
});

for(const n of local) it(`${n}: refuses an unowned existing skill before probing or writing`,async()=>{
 await scenario({name:`wave2-b1-${n}-unowned`,env,files:{[`.hermes/skills/hstack-${n}/SKILL.md`]:'user-owned content\n'},script:assemble([part(n,['step0#1','step0#2']),part(n,['step3#1']),SCRIPT_END])},r=>{
  assert.equal(r.code,1,r.out);assert.match(r.out,/not safely replaceable/);assert.equal(r.sb.read(`.hermes/skills/hstack-${n}/SKILL.md`),'user-owned content\n');
  assert.equal(r.sb.read('.hermes/.env'),null);assert.equal(r.sb.read('.hermes/config.yaml'),null);
 });
});

it('DigitalOcean keeps selected services and their credentials separate',async()=>{
 const second=assemble(['finish\nDO_SERVICE=apps\nDO_TOKEN=dop_v1_'+ 'A'.repeat(64)+'\n',part('digitalocean',['step2#1','step5#1','step6#1'])]);
 await scenario({name:'wave2-b1-do-isolation',env,script:script('digitalocean',second)},r=>{
  assert.equal(r.code,0,r.out);const creds=r.sb.read('.hermes/.env');const cfg=r.sb.read('.hermes/config.yaml');
  assert.match(creds,/MCP_DO_DROPLETS_API_KEY=dop_v1_N+/);assert.match(creds,/MCP_DO_APPS_API_KEY=dop_v1_A+/);
  assert.ok(cfg.includes('${MCP_DO_DROPLETS_API_KEY}'));assert.ok(cfg.includes('${MCP_DO_APPS_API_KEY}'));
 });
});

it('ElevenLabs clone tool remains excluded without the acknowledged opt-in',async()=>{
 await scenario({name:'wave2-b1-eleven-no-clone',env,script:script('elevenlabs')},r=>{
  assert.equal(r.code,0,r.out);assert.match(r.sb.read('.hermes/config.yaml'),/mcp_servers\.elevenlabs\.tools\.exclude: \["voice_clone"\]/);
 });
});

for(const n of local) it(`${n}: recovery preserves a concurrent user edit and retains the active backup`,async()=>{
 const tail=`printf 'user edited workflow\\n' | remote 'cat > "$HOME/.hermes/skills/hstack-${n}/SKILL.md"'\nfail_transaction\n`;
 await scenario({name:`wave2-b1-${n}-edited-recovery`,env,seed:{env:'KEEP=original\n',config:'model.default: original\n'},script:script(n,tail)},r=>{
  assert.equal(r.code,1,r.out);assert.equal(r.sb.read(`.hermes/skills/hstack-${n}/SKILL.md`),'user edited workflow\n');
  assert.ok(r.sb.exists(`.hermes/.hstack-backup/integration-${n}/.complete`));
  assert.equal(r.sb.read(`.hermes/.hstack-backup/integration-${n}/.env`),'KEEP=original\n');
  assert.match(r.out,/edited or is unowned; active backup retained/);
 });
});
