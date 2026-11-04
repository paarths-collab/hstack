import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuthStore } from '../dist/auth-store.js';
import { credentialCodec, aesCredentialCodec } from '../dist/credential-codec.js';
import { oauthStore, StoredOAuthProvider } from '../dist/oauth.js';

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'hstack-vault-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const keyFile=join(root,'master');await writeFile(keyFile,randomBytes(32),{mode:0o600});
  const env={HSTACK_STATE_DIR:root,HSTACK_CREDENTIAL_BACKEND:'keyfile',HSTACK_MASTER_KEY_FILE:keyFile};
  return {root,keyFile,env,store:new AuthStore(root,'fixture',credentialCodec(root,env))};
}

test('encrypted credentials survive process-independent reads and never store plaintext secrets',async t=>{
  const {root,env,store}=await fixture(t);const value={tokens:{access_token:'synthetic-access',refresh_token:'synthetic-refresh'}};
  await store.locked(AbortSignal.timeout(1000),()=>store.write(value));
  const disk=await readFile(store.path,'utf8');assert.ok(!disk.includes('synthetic-'));assert.equal(JSON.parse(disk).hstackVault,1);
  const other=new AuthStore(root,'fixture',credentialCodec(root,env));
  assert.deepEqual(await other.read(),value);
  await other.locked(AbortSignal.timeout(1000),()=>other.write({...value,revision:2}));
  assert.equal((await store.read()).revision,2);
});

test('vault rejects tampering, swapped credential identities, a missing key and plaintext downgrade',async t=>{
  const {root,env,store,keyFile}=await fixture(t);
  await store.locked(AbortSignal.timeout(1000),()=>store.write({key:'synthetic'}));
  const original=await readFile(store.path,'utf8');const changed=JSON.parse(original);changed.data=Buffer.alloc(20,1).toString('base64');
  await writeFile(store.path,JSON.stringify(changed));await assert.rejects(store.read(),/vault is unavailable/);
  await writeFile(store.path,original);
  const other=new AuthStore(root,'different-identity',credentialCodec(root,env));await writeFile(other.path,original,{mode:0o600});
  await assert.rejects(other.read(),/vault is unavailable/);
  await assert.rejects(new AuthStore(root,'fixture').read(),/require their configured vault/);
  await rm(keyFile);await assert.rejects(store.read(),/vault is unavailable/);
  // Explicit local disconnect must work even when the vault key is unavailable.
  await store.locked(AbortSignal.timeout(1000),()=>store.remove());
  assert.equal(await store.read(),undefined);
});

test('plaintext migration is explicit, atomic, idempotent and preserves data when encryption fails',async t=>{
  const {root,env,store}=await fixture(t);const legacy=new AuthStore(root,'fixture');
  await legacy.locked(AbortSignal.timeout(1000),()=>legacy.write({key:'synthetic-legacy',active:true}));
  await assert.rejects(store.read(),error=>error.details.recovery==='migrate_credentials');
  const failing=new AuthStore(root,'fixture',aesCredentialCodec(async()=>{throw Error('synthetic secret must stay hidden')}));
  await assert.rejects(failing.locked(AbortSignal.timeout(1000),()=>failing.migrate()));
  assert.equal((await legacy.read()).key,'synthetic-legacy');
  assert.equal(await store.locked(AbortSignal.timeout(1000),()=>store.migrate()),true);
  assert.equal(await store.locked(AbortSignal.timeout(1000),()=>store.migrate()),false);
  assert.deepEqual(await store.read(),{key:'synthetic-legacy',active:true});
  assert.ok(!(await readFile(store.path,'utf8')).includes('synthetic-legacy'));
});

test('master-key file must be owner-only, exactly 32 bytes and not a symlink',async t=>{
  const {keyFile,env,root,store}=await fixture(t);
  await chmod(keyFile,0o644);await assert.rejects(store.locked(AbortSignal.timeout(1000),()=>store.write({key:'synthetic'})));
  await chmod(keyFile,0o600);await writeFile(keyFile,'short');await assert.rejects(store.locked(AbortSignal.timeout(1000),()=>store.write({key:'synthetic'})));
  await writeFile(keyFile,randomBytes(32));const link=join(root,'link');await symlink(keyFile,link);
  const other=new AuthStore(root,'other',credentialCodec(root,{...env,HSTACK_MASTER_KEY_FILE:link}));
  await assert.rejects(other.locked(AbortSignal.timeout(1000),()=>other.write({key:'synthetic'})));
});

test('OAuth access and refresh tokens use the encrypted store and revocation stays encrypted',async t=>{
  const {env}=await fixture(t);
  const config={id:'fixture',url:'https://example.invalid/mcp',oauth:{type:'oauth',clientId:'synthetic-client',issuer:'https://example.invalid'}};
  const store=oauthStore(config,env), provider=new StoredOAuthProvider(config,store,env);
  await store.locked(AbortSignal.timeout(1000),()=>provider.saveTokens({access_token:'synthetic-access',refresh_token:'synthetic-refresh',token_type:'Bearer',issuer:'https://example.invalid'}));
  assert.ok(!(await readFile(store.path,'utf8')).includes('synthetic-access'));
  const other=new StoredOAuthProvider(config,oauthStore(config,env),env);await other.load();
  assert.equal(other.tokens().refresh_token,'synthetic-refresh');
  await store.locked(AbortSignal.timeout(1000),()=>other.invalidateCredentials('tokens'));
  await provider.load();assert.equal(provider.tokens(),undefined);
});


test('explicit replacement and removal recover a corrupted safe file without decrypting it', async t => {
  const {store}=await fixture(t);
  await store.locked(AbortSignal.timeout(1000),()=>store.write({key:'synthetic-old'}));
  await writeFile(store.path,'{corrupt');await assert.rejects(store.read());
  await store.locked(AbortSignal.timeout(1000),()=>store.replace({key:'synthetic-new'}));
  assert.equal((await store.read()).key,'synthetic-new');
  await writeFile(store.path,'{corrupt');
  await store.locked(AbortSignal.timeout(1000),()=>store.remove());assert.equal(await store.read(),undefined);
});
