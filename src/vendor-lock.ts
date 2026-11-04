import { lstat } from 'node:fs/promises';
import { isAbsolute, join, dirname, basename } from 'node:path';
import { AuthStore } from './auth-store.js';
import { DiscoveryError } from './errors.js';
import type { ResultPolicy } from './vendor-contracts.js';

const unsafe=()=>new DiscoveryError('Zendesk requires a private owner-only vendor HOME and config file. Use the dedicated setup home; symlinks and shared files are unsupported.',{code:'UNAVAILABLE',outcome:'not_sent'});

export async function validateQuickBooksStore(path:string|undefined):Promise<void>{
  const invalid=()=>new DiscoveryError('QuickBooks requires an absolute native token-store path with an owner-only parent directory and regular 0600 file. Symlinks and shared files are unsupported.',{code:'UNAVAILABLE',outcome:'not_sent'});
  if(process.platform==='win32'||!path||!isAbsolute(path)||!process.getuid)throw invalid();
  try{
    const parent=await lstat(dirname(path)),file=await lstat(path),uid=process.getuid();
    if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==uid||(parent.mode&0o077)!==0||(parent.mode&0o700)!==0o700
      ||!file.isFile()||file.isSymbolicLink()||file.uid!==uid||(file.mode&0o077)!==0||(file.mode&0o600)!==0o600||file.nlink!==1||file.size>1_000_000)throw invalid();
  }catch{throw invalid();}
}

/** Metadata checks only; Hstack never opens or copies native vendor credentials. */
async function validateHome(home:string):Promise<void>{
  if(process.platform==='win32'||!isAbsolute(home)||!process.getuid)throw unsafe();
  const check=async(path:string,directory:boolean,privateMode:boolean,optional=false)=>{
    let info;try{info=await lstat(path);}catch(error){if(optional&&(error as NodeJS.ErrnoException).code==='ENOENT')return;throw unsafe();}
    if(info.isSymbolicLink()||info.uid!==process.getuid!()||(directory?!info.isDirectory():!info.isFile())
      ||(privateMode&&(info.mode&0o077)!==0)||(!directory&&(info.nlink!==1||info.size>1_000_000)))throw unsafe();
  };
  await check(home,true,true);
  // Python mkdir(parents=True) can create this intermediate folder as 0755.
  // HOME is already private; still refuse a symlink or a different owner.
  await check(join(home,'.config'),true,false,true);
  await check(join(home,'.config','zendesk-mcp'),true,true,true);
  await check(join(home,'.config','zendesk-mcp','config.json'),false,true,true);
}

export async function vendorCredentialGuard(policy:ResultPolicy|undefined,settings:Record<string,string>){
  if(policy!=='zendesk-0.1.6'&&policy!=='quickbooks-31a1dd5')return undefined;
  const home=settings.HOME,path=settings.QUICKBOOKS_TOKEN_STORE_PATH;
  const validate=policy==='quickbooks-31a1dd5'?()=>validateQuickBooksStore(path):()=>home?validateHome(home):Promise.reject(unsafe());
  await validate();
  // Co-located with the native configuration, so different Hstack state roots
  // still coordinate. No token contents or new credential copy lives here.
  const store=policy==='quickbooks-31a1dd5'
    ?new AuthStore(join(dirname(path!),'.hstack-quickbooks-locks'),['quickbooks-native-store-31a1dd5',basename(path!)])
    :new AuthStore(join(home!,'.hstack-zendesk-locks'),['zendesk-native-config-v0.1.6']);
  const active=new Set<Promise<unknown>>();
  return{run:async<T>(signal:AbortSignal,operation:()=>Promise<T>):Promise<T>=>{
    let started=false;
    const task=store.locked(signal,async()=>{await validate();started=true;return operation();});active.add(task);
    try{return await task;}
    catch(error){if(!started&&error instanceof DiscoveryError)throw new DiscoveryError(error.message,{...error.details,outcome:'not_sent'});throw error;}
    finally{active.delete(task);}
  },drain:async()=>{await Promise.allSettled([...active]);}};
}
