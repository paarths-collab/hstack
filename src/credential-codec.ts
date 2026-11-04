import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { DiscoveryError } from './errors.js';

export interface CredentialCodec {
  seal(value: unknown, context: string): Promise<unknown>;
  open(value: unknown, context: string): Promise<unknown>;
}
const unavailable = () => new DiscoveryError('Credential vault is unavailable. Unlock the OS keychain or check the configured private master-key file. No plaintext fallback was used.', {code:'UNAVAILABLE', recovery:'unlock_credentials', outcome:'not_sent'});

export function encryptedEnvelope(value: unknown): boolean {
  return !!value && typeof value === 'object' && Object.hasOwn(value, 'hstackVault');
}
/** Injected key source allows real cryptography to be tested without OS credentials. */
export function aesCredentialCodec(key: (create: boolean) => Promise<Buffer>): CredentialCodec {
  return {
    async seal(value, context) {
      const master = await key(true);
      try {
        if (master.length !== 32) throw unavailable();
        const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',master,iv);
        cipher.setAAD(Buffer.from(`hstack-vault-v1\0${context}`));
        const ciphertext=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
        return {hstackVault:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:ciphertext.toString('base64')};
      } finally { master.fill(0); }
    },
    async open(value, context) {
      if (!encryptedEnvelope(value)) throw new DiscoveryError('Legacy plaintext credentials require explicit migration before use. Use the credential migration action or replace the saved key.', {code:'UNAVAILABLE',recovery:'migrate_credentials',outcome:'not_sent'});
      let master: Buffer | undefined;
      try {
        const record=value as Record<string,unknown>;
        if (record.hstackVault!==1 || Object.keys(record).sort().join(',')!=='data,hstackVault,iv,tag'
          || !['iv','tag','data'].every(k=>typeof record[k]==='string' && /^[A-Za-z0-9+/]*={0,2}$/.test(record[k] as string))) throw unavailable();
        const iv=Buffer.from(record.iv as string,'base64'),tag=Buffer.from(record.tag as string,'base64');
        if(iv.length!==12||tag.length!==16)throw unavailable();
        master=await key(false);
        if(master.length!==32)throw unavailable();
        const decipher=createDecipheriv('aes-256-gcm',master,iv);
        decipher.setAAD(Buffer.from(`hstack-vault-v1\0${context}`));decipher.setAuthTag(tag);
        return JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.data as string,'base64')),decipher.final()]).toString('utf8'));
      } catch { throw unavailable(); } finally {master?.fill(0)}
    },
  };
}

export async function keychainRequest(action: 'read'|'create'|'delete', root: string): Promise<Buffer | undefined> {
  const account=createHash('sha256').update(root).digest('hex');
  const helper=fileURLToPath(new URL('../dist/keychain-helper',import.meta.url));
  return new Promise((resolve,reject)=>{
    const child=spawn(helper,[],{stdio:['pipe','pipe','ignore'],env:{PATH:'/usr/bin:/bin'}});
    let output='', settled=false;
    const fail=()=>{if(!settled){settled=true;child.kill();reject(unavailable())}};
    const timer=setTimeout(fail,10_000);
    child.on('error',fail);child.stdin.on('error',fail);
    child.stdout.on('data',chunk=>{output+=chunk;if(output.length>4096)fail()});
    child.on('close',code=>{
      clearTimeout(timer);if(settled)return;settled=true;
      try {
        const result=JSON.parse(output);
        if(code!==0)throw unavailable();
        if(action==='delete'&&result.deleted===true){resolve(undefined);return}
        if(typeof result.key!=='string')throw unavailable();
        const bytes=Buffer.from(result.key,'base64');if(bytes.length!==32)throw unavailable();resolve(bytes);
      }catch{reject(unavailable())}
    });
    child.stdin.end(JSON.stringify({action,account}));
  });
}

export function credentialCodec(root: string, env: NodeJS.ProcessEnv): CredentialCodec | undefined {
  const backend=env.HSTACK_CREDENTIAL_BACKEND ?? process.env.HSTACK_CREDENTIAL_BACKEND ?? (process.platform==='darwin'?'keychain':'keyfile');
  if(backend==='plaintext')return undefined; // Explicit compatibility/testing opt-in only.
  if(backend==='keychain') {
    if(process.platform!=='darwin')throw unavailable();
    return aesCredentialCodec(async create => (await keychainRequest(create?'create':'read',root))!);
  }
  if(backend!=='keyfile')throw unavailable();
  return aesCredentialCodec(async()=>{
    const path=env.HSTACK_MASTER_KEY_FILE ?? process.env.HSTACK_MASTER_KEY_FILE;
    if(!path||!isAbsolute(path)||process.platform==='win32')throw unavailable();
    let file;
    try {
      file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
      const info=await file.stat();
      if(!info.isFile()||info.uid!==process.getuid?.()||info.nlink!==1||(info.mode&0o077)!==0||info.size!==32)throw unavailable();
      return await file.readFile();
    }catch{throw unavailable()}finally{await file?.close()}
  });
}
