// Opt-in native macOS check. Owns one disposable vault item; no existing keys read.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuthStore } from '../dist/auth-store.js';
import { credentialCodec, keychainRequest } from '../dist/credential-codec.js';

if(process.platform!=='darwin')throw Error('Native Keychain verification requires macOS.');
const root=await mkdtemp(join(tmpdir(),'hstack-native-vault-'));
try {
  const store=new AuthStore(root,'synthetic-verification',credentialCodec(root,{HSTACK_CREDENTIAL_BACKEND:'keychain'}));
  await store.locked(AbortSignal.timeout(20_000),()=>store.write({key:'synthetic-never-a-real-credential'}));
  if((await store.read()).key!=='synthetic-never-a-real-credential'||(await readFile(store.path,'utf8')).includes('synthetic-never-a-real-credential'))throw Error('Verification failed');
  await store.locked(AbortSignal.timeout(20_000),()=>store.remove());
  console.log('PASS: native macOS Keychain-held key encrypts/decrypts credentials; no plaintext on disk.');
} catch {
  console.error('FAIL: native Keychain storage unavailable or verification did not pass. No raw diagnostics printed.');process.exitCode=1;
} finally {
  try{await keychainRequest('delete',root)}catch{console.error('Disposable vault item cleanup failed; raw diagnostics hidden.');process.exitCode=1}
  await rm(root,{recursive:true,force:true});
}
