import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { reviewedOAuthTargets, verifyRemainingOAuthMetadata } from '../scripts/verify-remaining-oauth-metadata.mjs';
import { checkSetup } from '../dist/setup-check.js';

function fixture(change=()=>{}){
  const documents=new Map(),seen=[];
  for(const target of reviewedOAuthTargets){
    const issuer=target.id==='brand24'?'https://oauth.brand24.com/resources/synthetic':target.id==='kit'?'https://api.kit.com':
      target.id==='readwise'?'https://readwise.io/o/':target.id==='evernote'?'https://accounts.evernote.com':
      target.id==='trello'?'https://auth.atlassian.com/synthetic':new URL(target.endpoint).origin;
    const server={issuer,authorization_endpoint:`${issuer.replace(/\/$/,'')}/authorize`,token_endpoint:`${issuer.replace(/\/$/,'')}/token`,
      registration_endpoint:`${issuer.replace(/\/$/,'')}/register`,response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],
      code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:target.id==='pandadoc'?['client_secret_post','client_secret_basic']:['none'],
      client_id_metadata_document_supported:['brand24','calcom','trello'].includes(target.id)};
    documents.set(target.id,{resource:{resource:target.endpoint,authorization_servers:[issuer]},server});
  }
  change(documents);
  return{seen,fetch:async(url,init)=>{
    assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');assert.ok(init.signal instanceof AbortSignal);
    const parsed=new URL(url);assert.ok(parsed.pathname.includes('/.well-known/'));
    seen.push(url);const target=reviewedOAuthTargets.find(t=>t.origins.includes(parsed.origin));
    assert.ok(target,'A new IdP or account URL must never be fetched');
    const doc=documents.get(target.id);if(!doc)return Response.json({}, {status:503});
    return Response.json(parsed.pathname.includes('oauth-protected-resource')?doc.resource:doc.server);
  }};
}

test('remaining OAuth audit uses only public SDK metadata GETs and distinguishes successful discovery from DCR requirements',async()=>{
  const f=fixture(),report=await verifyRemainingOAuthMetadata(f.fetch);
  assert.equal(report.allDiscovered,true);assert.equal(report.services.length,8);assert.equal(f.seen.length,16);
  assert.ok(report.services.every(s=>s.pkceS256Advertised&&s.refreshAdvertised));
  const panda=report.services.find(s=>s.id==='pandadoc');assert.equal(panda.bootstrap.nativePublicClientMethodAdvertised,false);
  assert.equal(panda.bootstrap.registrationMethodReviewRequired,true);
  assert.match(report.services.find(s=>s.id==='trello').issuer,/\/synthetic$/,'Scoped issuers must not be replaced with origin metadata');
  assert.match(report.services.find(s=>s.id==='readwise').issuer,/\/o\/$/);
});

test('remaining OAuth audit refuses new authorization origins without fetching them or hiding them behind fallback success',async()=>{
  const f=fixture(docs=>{docs.get('kit').resource.authorization_servers=['https://unreviewed.invalid/private'];});
  const report=await verifyRemainingOAuthMetadata(f.fetch);
  assert.equal(report.allDiscovered,false);assert.equal(report.services.filter(s=>s.officialSdkDiscovery).length,7);
  assert.equal(report.services.find(s=>s.id==='kit').failure.code,'AUTHORIZATION_ORIGIN_REVIEW_REQUIRED');
  assert.ok(f.seen.every(url=>!url.includes('unreviewed.invalid')));
});

test('remaining OAuth audit isolates an unavailable endpoint without treating metadata failure as a credential problem',async()=>{
  const f=fixture(docs=>docs.delete('evernote')),report=await verifyRemainingOAuthMetadata(f.fetch);
  assert.equal(report.allDiscovered,false);assert.equal(report.services.filter(s=>s.officialSdkDiscovery).length,7);
  const failed=report.services.find(s=>s.id==='evernote');assert.equal(failed.failure.code,'PUBLIC_METADATA_CHECK_FAILED');
  assert.ok(failed.requests.some(r=>r.status===503));
});

test('remaining OAuth audit preserves the native SDK issuer check',async()=>{
  const f=fixture(docs=>{docs.get('calcom').server.issuer='https://wrong.invalid';}),report=await verifyRemainingOAuthMetadata(f.fetch);
  assert.equal(report.services.find(s=>s.id==='calcom').officialSdkDiscovery,false);
  assert.equal(report.services.find(s=>s.id==='calcom').failure.code,'ISSUER_MISMATCH');
});

for(const [id,count,blocked]of [['kit',38,['create_broadcast','bulk_tag_subscribers','unsubscribe']],
  ['evernote',10,['edit_note','delete_note','get_attachment']],['calcom',43,['create_booking','cancel_booking','call_api_operation']],
  ['pandadoc',0,['send_document','create_document']]])test(`${id}: native OAuth candidate keeps documented read boundaries and requires real vendor validation`,async()=>{
  const profile=JSON.parse(await readFile(`integrations/${id}/connection.json`,'utf8'));
  const report=await checkSetup(profile,{});assert.deepEqual(report.issues,[]);
  assert.equal(profile.enabled,false);assert.equal(profile.allowWrites,false);assert.equal(profile.readTools.length,count);
  for(const tool of blocked)assert.equal(profile.readTools.includes(tool),false);
  if(id==='evernote')assert.equal(profile.oauth.scope,'read');
  if(id==='pandadoc'){
    assert.equal(profile.oauth.dcrAuthMethod,'client_secret_post');assert.equal(profile.oauth.scope,'read documents:read');
    assert.match(report.notes.join(' '),/generated client secret.*private plaintext OAuth store/);
  }
});
