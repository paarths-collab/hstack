// Routine fixtures must never open a real OS keychain or inherit a vault key.
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
const files = readdirSync('tests').filter(n => n.endsWith('.test.mjs')).sort().map(n => `tests/${n}`);
const env = {...process.env, HSTACK_CREDENTIAL_BACKEND:'plaintext'};
delete env.HSTACK_MASTER_KEY_FILE;
const child=spawn(process.execPath,['--test',...files],{stdio:'inherit',env});
child.on('error',()=>{process.exitCode=1});child.on('exit',code=>{process.exitCode=code??1});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>child.kill(signal));
