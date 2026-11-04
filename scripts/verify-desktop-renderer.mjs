// Optional real React component driver. The Hermes shell/SDK routing is a fixture.
// Private JSON-line IPC only: the parent owns the HTTP backend and captures stdout.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

const pending = new Map();let counter=0, initialize;
const initialized = new Promise(resolve => {initialize=resolve});
const lines = createInterface({input:process.stdin});
lines.on('line',line=>{
  const value=JSON.parse(line);
  if (value.kind==='initialize') initialize(value);
  else {const task=pending.get(value.id);pending.delete(value.id);value.error?task.reject(Error('Backend request failed')):task.resolve(value.result)}
});
const request=(path,options)=>new Promise((resolve,reject)=>{
  const id=++counter;pending.set(id,{resolve,reject});process.stdout.write(JSON.stringify({id,path,options})+'\n');
});
let temporary;
try {
  const config=await initialized;
  const require=createRequire(join(resolve(config.dependencies),'package.json'));
  const {JSDOM}=require('jsdom');
  const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'});
  globalThis.window=dom.window;globalThis.document=dom.window.document;
  Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
  globalThis.HTMLElement=dom.window.HTMLElement;globalThis.MutationObserver=dom.window.MutationObserver;
  globalThis.IS_REACT_ACT_ENVIRONMENT=true;
  const React=require('react');const {render,screen,fireEvent,waitFor,cleanup}=require('@testing-library/react');
  temporary=await mkdtemp(join(tmpdir(),'hstack-renderer-'));
  await symlink(resolve(config.dependencies),join(temporary,'node_modules'),'dir');
  await writeFile(join(temporary,'package.json'),'{"type":"module"}');
  // Only the shell's read-only routing atoms are fixtures; the plugin component,
  // React hooks/events and every ctx.rest backend call execute for real.
  await writeFile(join(temporary,'sdk.js'),`import {useSyncExternalStore} from 'react';
const atom=value=>({get:()=>value,subscribe:()=>()=>{}});
export const host={state:{profile:atom('default'),connectionId:atom('local')}};
export const useValue=atom=>useSyncExternalStore(atom.subscribe,atom.get);
`);
  const source=await readFile(new URL('../hermes-plugin/hstack-connections/desktop/plugin.js',import.meta.url),'utf8');
  await writeFile(join(temporary,'plugin.js'),source.replace("'@hermes/plugin-sdk'","'./sdk.js'"));
  const plugin=(await import(pathToFileURL(join(temporary,'plugin.js')).href)).default;
  let contribution;
  plugin.register({rest:request,registerSettingsPage:value=>{contribution=value}});
  render(contribution.render());
  const click=async name=>{
    const button=screen.getByRole('button',{name,exact:true});
    await waitFor(()=>assert.equal(button.disabled,false),{timeout:130000});
    fireEvent.click(button);
    await waitFor(()=>assert.equal(screen.getByRole('combobox').disabled,false),{timeout:130000});
  };
  await waitFor(()=>assert.equal(screen.getByRole('combobox').disabled,false),{timeout:10000});
  assert.equal(screen.getByRole('button',{name:'3. Activate in Hermes'}).disabled,true);
  fireEvent.change(screen.getByLabelText('Buffer API key'),{target:{value:config.key}});
  await click('1. Save key');
  assert.equal(screen.getByLabelText('Buffer API key').value,'');
  assert.equal(screen.getByRole('button',{name:'3. Activate in Hermes'}).disabled,true);
  await click('2. Validate key');await click('3. Activate in Hermes');await click('4. Use read tool');
  assert.match(screen.getByRole('status').textContent,/native MCP registry executed buffer__get_account/);
  await click('Deactivate');
  assert.equal(screen.getByRole('button',{name:'4. Use read tool'}).disabled,true);
  await click('Remove saved key');
  assert.match(screen.getByRole('status').textContent,/Saved key removed/);
  cleanup();dom.window.close();
  process.stdout.write(JSON.stringify({kind:'complete',passed:true})+'\n');
} catch {
  process.stdout.write(JSON.stringify({kind:'complete',passed:false})+'\n');process.exitCode=1;
} finally {
  lines.close();process.stdin.destroy();
  if (temporary) await rm(temporary,{recursive:true,force:true});
}
