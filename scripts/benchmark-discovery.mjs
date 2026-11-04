import { readFile, writeFile } from 'node:fs/promises';
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createSocialGateway } from '../dist/gateway.js';

// Reproducible synthetic comparison; no live accounts, models or token estimates.
const services=JSON.parse(await readFile(new URL('../catalog/services.json',import.meta.url),'utf8'));
const providers=services.map(({id,name})=>({id,label:name,allowWrites:false,
 readTools:new Set(Array.from({length:12},(_,n)=>`get_record_${n}`)),
 tools:Array.from({length:12},(_,n)=>({name:`get_record_${n}`,description:`Retrieve an existing ${name} business record with explicit filtering and paging. Return structured information, respect account permissions, and report provider failures without changing data.`,inputSchema:{type:'object',properties:{id:{type:'string'},limit:{type:'integer',minimum:1,maximum:100},cursor:{type:'string'}},required:['id'],additionalProperties:false}})),
 call:async()=>({content:[{type:'text',text:'synthetic record'}]})
}));
async function measure(mode){
 const server=createSocialGateway(providers,{toolMode:mode}),client=new Client({name:'benchmark',version:'0'});
 const[a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
 try{
  const listing=await client.listTools();
  let searchBytes=0;
  if(mode==='search'){
   const found=await client.callTool({name:'hstack_search_tools',arguments:{query:'record',service:'brevo',limit:3}});
   searchBytes=Buffer.byteLength(JSON.stringify(found));
   const result=await client.callTool({name:'hstack_call_tool',arguments:{name:'brevo__get_record_0',arguments:{id:'fixture'}}});
   if(result.isError)throw new Error('Call route failed');
  }
  return {advertisedTools:listing.tools.length,discoveryBytes:Buffer.byteLength(JSON.stringify(listing)),firstSearchResponseBytes:searchBytes};
 }finally{await client.close();await server.close();}
}
const direct={tools:providers.flatMap(provider=>provider.tools)};
const forward=await measure('forward'),search=await measure('search');
const result={fixture:'30 services x 12 synthetic tools each',direct:{advertisedTools:direct.tools.length,discoveryBytes:Buffer.byteLength(JSON.stringify(direct))},forward,search,initialDiscoveryReductionPercent:Number((100*(1-search.discoveryBytes/Buffer.byteLength(JSON.stringify(direct)))).toFixed(2)),limitations:['Measures JSON bytes, not model tokens, model accuracy, onboarding time or production latency.','Search mode needs a discovery tool call before execution.','Synthetic tool schemas do not prove live vendor compatibility.']};
await writeFile(new URL('../docs/benchmarks/discovery.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
