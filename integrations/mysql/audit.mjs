import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** govulncheck JSON is a stream of objects; JSON output can exit zero with findings. */
export function parseJsonStream(text){
  const values=[];let start=-1,depth=0,string=false,escaped=false;
  for(let i=0;i<text.length;i++){
    const char=text[i];
    if(start<0){if(/\s/.test(char))continue;if(char!=='{')throw new Error('Invalid audit stream');start=i;depth=1;continue;}
    if(string){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')string=false;continue;}
    if(char==='"')string=true;else if(char==='{')depth++;else if(char==='}'&&--depth===0){values.push(JSON.parse(text.slice(start,i+1)));start=-1;}
  }
  if(start>=0||!values.length)throw new Error('Incomplete audit stream');return values;
}

export function assessAudit(events,inventory){
  if(!inventory?.pkgSymbols?.length)throw new Error('Binary has no extracted symbol inventory; precise review is unavailable');
  if(!events.some(event=>event.config)||!events.some(event=>event.SBOM))throw new Error('Audit metadata is incomplete');
  const findings=events.flatMap(event=>Object.hasOwn(event,'finding')?[event.finding]:[]),modules=new Set(),linked=new Set();
  for(const finding of findings){
    if(!finding||typeof finding.osv!=='string'||!finding.trace?.length)throw new Error('Malformed audit finding');
    if(finding.trace.some(frame=>frame.package||frame.function))linked.add(finding.osv);else modules.add(finding.osv);
  }
  if(linked.size)throw new Error(`Linked vulnerable packages or symbols reported: ${[...linked].sort().join(', ')}`);
  return{linkedAdvisories:[],moduleOnlyAdvisories:[...modules].sort(),extractedSymbols:inventory.pkgSymbols.length,
    note:'Module-only advisory matches are retained. No affected package/symbol was identified in this exact binary; this is not a zero-advisory module graph claim.'};
}

async function main(){
  const binary=process.env.HSTACK_MYSQL_TOOLBOX,checker=process.env.HSTACK_GOVULNCHECK;
  if(!binary||!checker||!isAbsolute(binary)||!isAbsolute(checker))throw new Error('Set absolute HSTACK_MYSQL_TOOLBOX and HSTACK_GOVULNCHECK paths');
  const manifest=JSON.parse(await readFile(new URL('./toolbox-release.json',import.meta.url),'utf8'));
  const sha256=createHash('sha256').update(await readFile(binary)).digest('hex');
  if(sha256!==manifest.compatibilityBuild.platforms[`${process.platform}-${process.arch}`]?.sha256)throw new Error('Binary is not the validated platform build');
  const execute=promisify(execFile),options={timeout:60_000,maxBuffer:25_000_000};
  const extracted=parseJsonStream((await execute(checker,['-mode=extract',binary],options)).stdout);
  const inventory=extracted.find(item=>item.pkgSymbols);
  const events=parseJsonStream((await execute(checker,['-mode=binary','-json',binary],options)).stdout);
  console.log(JSON.stringify({toolboxVersion:manifest.version,binarySha256:sha256,goVersion:inventory?.goVersion,...assessAudit(events,inventory)},null,2));
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{await main();}catch(error){console.error(error instanceof Error?error.message:'Binary audit failed');process.exitCode=1;}
}
