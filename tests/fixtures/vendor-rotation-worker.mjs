import { loadConnection } from '../../dist/connections.js';
import { resolve } from 'node:path';
let provider;
try{
  provider=await loadConnection({id:'zendesk',label:'Synthetic native vendor',enabled:false,transport:'stdio',command:process.execPath,
    args:[resolve('tests/fixtures/vendor-rotation-server.mjs')],env:{HOME:'FIXTURE_HOME',ZENDESK_MCP_READ_ONLY:'FIXTURE_READ_ONLY'},
    resultPolicy:'zendesk-0.1.6',readTools:['zendesk_get_groups'],allowWrites:false},{FIXTURE_HOME:process.env.FIXTURE_HOME,FIXTURE_READ_ONLY:'true'});
  console.log('ready');await new Promise(resolve=>process.stdin.once('data',resolve));
  const result=await provider.call('zendesk_get_groups',{},AbortSignal.timeout(5000));
  if(result.isError)throw new Error('Synthetic vendor call failed');
  console.log(JSON.parse(result.content[0].text)[0].id);
}catch{console.error('Synthetic vendor worker failed');process.exitCode=1;}
finally{await provider?.close();process.stdin.destroy();}
