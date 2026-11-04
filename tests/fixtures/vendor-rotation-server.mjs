import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
const state=join(process.env.HOME,'.config/zendesk-mcp/config.json'),events=join(process.env.HOME,'events.jsonl');
const server=new Server({name:'synthetic-native-vendor',version:'0'},{capabilities:{tools:{}}});
server.setRequestHandler('tools/list',()=>({tools:[{name:'zendesk_get_groups',inputSchema:{type:'object',properties:{}}}]}));
server.setRequestHandler('tools/call',async()=>{
  const before=JSON.parse(await readFile(state,'utf8')).revision;
  await appendFile(events,JSON.stringify({event:'start',revision:before})+'\n');
  await new Promise(resolve=>setTimeout(resolve,150));
  const current=JSON.parse(await readFile(state,'utf8')).revision;
  if(current!==before)return{isError:true,content:[{type:'text',text:'Synthetic native rotation collision'}]};
  await writeFile(state,JSON.stringify({revision:before+1}),{mode:0o600});
  await appendFile(events,JSON.stringify({event:'end',revision:before+1})+'\n');
  return{content:[{type:'text',text:JSON.stringify([{id:before+1,name:'Synthetic group'}])}]};
});
await server.connect(new StdioServerTransport());
