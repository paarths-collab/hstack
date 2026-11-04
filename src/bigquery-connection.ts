import type { Connection } from './connections.js';
import type { LoadedProvider } from './providers.js';
import { BIGQUERY_ENDPOINT, rejectUnknownBigQueryResult } from './bigquery-discovery.js';
import { GoogleBigQueryCredentials } from './google-credentials.js';
import { DiscoveryError } from './errors.js';
import { createBigQuerySchemaValidator } from './bigquery-schema.js';
import { RemoteConnection } from './remote-connection.js';

export async function loadBigQueryConnection(config: Connection, env: NodeJS.ProcessEnv,
  cancellation?: AbortSignal, fetchImpl: typeof fetch = fetch,
): Promise<LoadedProvider> {
  const validator = createBigQuerySchemaValidator();
  // Constructing the native provider does not read a file or request a token.
  const auth = new GoogleBigQueryCredentials(env[config.googleBigQuery!.credentialsFileEnv], fetchImpl);
  const remote = new RemoteConnection({ endpoint:new URL(BIGQUERY_ENDPOINT),label:config.label,headers:{},protocol:'legacy',
    schemaValidator:validator,rejectSessionId:true,headersForCall:signal=>auth.headers(signal),
    onCallFailure:async failure=>{if(failure.details.code==='AUTH_REQUIRED')await auth.invalidateAccessToken();},
    beforeCall:async tool=>{
      const hasHeader=(value:unknown):boolean=>!!value&&typeof value==='object'
        &&(Object.hasOwn(value,'x-mcp-header')||Object.values(value).some(hasHeader));
      if(hasHeader(tool.inputSchema))throw new DiscoveryError('BigQuery routing schema changed; review parameter headers before calling this tool.',{code:'UNAVAILABLE',outcome:'not_sent'});
    },
    fetch:async(url,init)=>{
      if(String(url)!==BIGQUERY_ENDPOINT)throw new Error('Unexpected endpoint.');
      const response=await fetchImpl(url,init);
      const method=JSON.parse(String(init?.body)).method;
      if(method==='tools/list'||method==='tools/call')await rejectUnknownBigQueryResult(response);
      return response;
    },
  });
  let tools;
  try { tools=await remote.discover(cancellation); }
  catch(error){try{await remote.close();}finally{await auth.close();}throw error;}
  return {
    id: config.id, label: config.label, tools, readTools: new Set(config.readTools),
    writeTools: new Set(config.writeTools ?? []), allowWrites: config.allowWrites, permissionSource: 'connection',
    schemaValidator: validator,
    lifecycle:()=>remote.status(),
    close:async()=>{try{await remote.close();}finally{await auth.close();}},
    call: async (name, args, signal) => {
      const result=await remote.call(name,args,signal);
      if(result.isError)throw new DiscoveryError('BigQuery tool returned an error. Review project, IAM, quota and operation settings; raw error content is hidden.',{code:'UPSTREAM_ERROR',outcome:'unknown'});
      return result;
    },
  };
}
