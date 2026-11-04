import { Client, StreamableHTTPClientTransport, ProtocolError } from '@modelcontextprotocol/client';
import type { ClientOptions, Tool, CallToolResult, OAuthClientProvider } from '@modelcontextprotocol/client';
import { CallToolResultSchema } from '@modelcontextprotocol/core';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { listAllTools, rejectRemoteHttpError, remoteFailure } from './discover-tools.js';
import { compileToolSchema } from './tool-schema.js';
import { DiscoveryError } from './errors.js';
import { waitWithSignal } from './cancellation.js';
import type { ConnectionLifecycle } from './local-connection.js';

interface Session { client: Client; transport: StreamableHTTPClientTransport; retired?: Promise<void> }
interface Operation { signal: AbortSignal; name?: string; dispatched: boolean; headers?: Record<string,string> }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([,v])=>v!==undefined)
    .sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}

/** One reusable official SDK HTTP client per provider. Operations are serialized
 * with independent total deadlines. Reconnect only before a NEW request, never
 * replay a dispatched call, and never silently accept a changed catalogue.
 * OAuth refresh/use stays under the shared filesystem lock for every operation. */
export class RemoteConnection {
  private session?: Session;
  private pending = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private shutdown = new AbortController();
  private active?: Operation;
  private cleanup = new Set<Promise<void>>();
  private closed = false;
  private changed = false;
  private connecting = false;
  private ready = false;
  private failures = 0;
  private connections = 0;
  private retryAt = 0;
  private cooldownUntil = 0;
  private cooldownWindow?: number;
  private key?: string;
  private credentialKey?: string;
  private tools: Tool[] = [];
  private validator: NonNullable<ClientOptions['jsonSchemaValidator']>;
  private endpoint: URL;
  constructor(private readonly config: {
    endpoint: URL; label: string; headers: Record<string,string>; protocol?: 'auto'|'legacy'|'2026-07-28';
    schemaValidator?: ClientOptions['jsonSchemaValidator']; fetch?: typeof fetch;
    headersForCall?: (signal: AbortSignal) => Promise<Record<string,string>>;
    beforeCall?: (tool: Tool, args: Record<string,unknown>, signal: AbortSignal) => Promise<void>;
    onCallFailure?: (failure: DiscoveryError) => Promise<void>;
    rejectSessionId?: boolean;
    authProvider?: OAuthClientProvider;
    withOperation?: <T>(signal: AbortSignal, operation: () => Promise<T>) => Promise<T>;
    credentialBinding?: () => string;
  }, private readonly options: { timeoutMs?: number; backoffMs?: number; now?: () => number } = {}) {
    if(config.authProvider&&(!config.withOperation||!config.credentialBinding||!config.fetch)){
      throw new DiscoveryError('Reused OAuth HTTP requires a locked operation, credential binding and reviewed OAuth fetch.',{code:'UNAVAILABLE',outcome:'not_sent'});
    }
    this.endpoint = new URL(config.endpoint.href);
    this.validator = config.schemaValidator ?? new AjvJsonSchemaValidator();
  }
  private now() { return (this.options.now ?? Date.now)(); }
  private deadline(signal?: AbortSignal) {
    return AbortSignal.any([this.shutdown.signal,AbortSignal.timeout(this.options.timeoutMs ?? 30_000),...(signal?[signal]:[])]);
  }
  status(): ConnectionLifecycle {
    return { state:this.closed?'closed':this.changed?'catalogue_changed':this.connecting?'connecting':this.ready?'ready':'backoff',
      reconnects:Math.max(0,this.connections-1),consecutiveFailures:this.failures,
      ...(!this.ready&&this.retryAt>this.now()?{retryAfterSeconds:Math.ceil((this.retryAt-this.now())/1000)}:{}) };
  }
  private unavailable(outcome:'not_sent'|'unknown'='not_sent') {
    return new DiscoveryError(this.closed?'Connection has been closed.':this.changed
      ?`${this.config.label} tool catalogue changed. Restart Hstack and review permissions.`
      :`${this.config.label} HTTP connection is unavailable. Retry a new request after recovery; the previous operation was not replayed.`, {
      code:'UNAVAILABLE',outcome,recovery:this.changed?'restart_hstack':'retry_later',
      ...(this.retryAt>this.now()?{retryAfterSeconds:Math.ceil((this.retryAt-this.now())/1000)}:{}),
    });
  }
  private cancelled(signal:AbortSignal,outcome:'not_sent'|'unknown') {
    return new DiscoveryError('HTTP MCP operation cancelled or timed out. Check the service before retrying a dispatched operation.', {
      code:signal.reason?.name==='TimeoutError'?'TIMEOUT':'CANCELLED',outcome,
    });
  }
  private retire(session:Session) {
    if(session.retired)return session.retired;
    if(this.session===session){this.session=undefined;this.ready=false;}
    const work=(async()=>{try{await session.client.close();}finally{await session.transport.close();}})();
    session.retired=work;this.cleanup.add(work);
    void work.then(()=>this.cleanup.delete(work),()=>this.cleanup.delete(work));return work;
  }
  private lost(session:Session) {
    if(this.session!==session||this.closed||this.changed)return;
    this.ready=false;this.failures++;this.retryAt=this.now()+Math.min(30_000,(this.options.backoffMs??250)*2**Math.min(this.failures-1,20));
    void this.retire(session).catch(()=>{});
  }
  private catalogueChanged(session:Session) {
    if(this.session!==session||this.closed)return;
    this.changed=true;void this.retire(session).catch(()=>{});
  }
  private async ensureReady(operation:Operation):Promise<Session> {
    operation.signal.throwIfAborted();
    if(this.closed||this.changed)throw this.unavailable();
    if(this.session&&this.ready)return this.session;
    if(this.retryAt>this.now())throw this.unavailable();
    await Promise.allSettled([...this.cleanup]);operation.signal.throwIfAborted();
    if(this.closed||this.changed)throw this.unavailable();
    const protocol=this.config.protocol??'auto';
    const client=new Client({name:'hstack-upstream',version:'0.0.0'},{versionNegotiation:{mode:protocol==='2026-07-28'?{pin:protocol}:protocol},
      listMaxPages:100,jsonSchemaValidator:this.validator});
    const transport=new StreamableHTTPClientTransport(this.endpoint,{authProvider:this.config.authProvider,onInsufficientScope:'throw',
      requestInit:{headers:{...this.config.headers}},fetch:async(url,init)=>{
      // No upstream subscriptions are relayed. In particular, a background GET
      // must not retain the startup deadline or race credential refresh.
      const mcp=String(url)===this.endpoint.href;
      if(mcp&&(init?.method==='GET'||init?.method==='DELETE'))return new Response(null,{status:405});
      const active=this.active;
      if(!active)throw new Error('No active HTTP operation.');
      const signal=AbortSignal.any([active.signal,...(init?.signal?[init.signal]:[])]);signal.throwIfAborted();
      // The SDK owns OAuth discovery/refresh. The configured OAuth fetch applies
      // URL/issuer checks and error-body normalization under this operation's lock.
      if(!mcp){
        if(!this.config.authProvider)throw new Error('Unexpected HTTP endpoint.');
        return(this.config.fetch??fetch)(url,{...init,signal,credentials:'omit',redirect:'error'});
      }
      if(init?.method!=='POST')throw new Error('Unexpected HTTP request.');
      const request=JSON.parse(String(init.body));
      if(request.method==='notifications/cancelled')return new Response(null,{status:202});
      if(!['initialize','notifications/initialized','server/discover','tools/list','tools/call'].includes(request.method)
        ||(request.method==='tools/call'&&request.params?.name!==active.name))throw new Error('Unexpected MCP method.');
      // SDK per-message headers deliberately exclude Authorization. Attach
      // native credential headers in this scoped fetch hook, to this call only.
      const headers=new Headers(init.headers);
      if(request.method==='tools/call')for(const[name,value]of Object.entries(active.headers??{})){
        if(/^mcp-/i.test(name))throw new Error('Credential headers cannot change protocol routing.');
        headers.set(name,value);
      }
      if(request.method==='tools/call')active.dispatched=true;
      const response=await(this.config.fetch??fetch)(url,{...init,headers,signal,credentials:'omit',redirect:'error'});
      if(this.config.rejectSessionId&&response.headers.has('mcp-session-id')){
        await response.body?.cancel();throw new DiscoveryError('The endpoint started a stateful session. Review identity/session binding before reuse.',{code:'UNAVAILABLE'});
      }
      // Authentication challenges must reach the native SDK, as on the former
      // one-shot path. Hstack adds no network/outcome replay of its own.
      if(!response.ok&&!(this.config.authProvider&&[401,403].includes(response.status)))await rejectRemoteHttpError(response,this.config.label);
      return response;
    }});
    const session:Session={client,transport};this.session=session;this.connecting=true;
    client.onclose=()=>this.lost(session);client.onerror=()=>{};
    client.setNotificationHandler('notifications/tools/list_changed',()=>this.catalogueChanged(session));
    try{
      await client.connect(transport,{signal:operation.signal});
      const tools=await listAllTools(client,operation.signal);
      if(new Set(tools.map(tool=>tool.name)).size!==tools.length)throw new Error('Duplicate tool');
      for(const tool of tools)compileToolSchema(this.validator,tool.inputSchema);
      const key=canonical([...tools].sort((a,b)=>a.name.localeCompare(b.name)));
      if(this.key!==undefined&&this.key!==key){this.catalogueChanged(session);throw this.unavailable();}
      operation.signal.throwIfAborted();
      if(this.closed||this.changed||this.session!==session)throw this.unavailable();
      this.key=key;this.tools=tools;this.ready=true;this.connections++;return session;
    }catch(error){this.lost(session);await this.retire(session).catch(()=>{});throw error;}
    finally{this.connecting=false;}
  }
  private run<T>(name:string|undefined,signal:AbortSignal|undefined,operation:(session:Session,context:Operation)=>Promise<T>):Promise<T>{
    if(this.pending>=64)return Promise.reject(new DiscoveryError('Connection request queue is full. Retry later; no request was sent.',{code:'UNAVAILABLE',outcome:'not_sent',recovery:'retry_later'}));
    this.pending++;
    const context:Operation={signal:this.deadline(signal),name,dispatched:false};
    const work=this.queue.then(async()=>{
      if(this.closed||this.changed)throw this.unavailable();
      context.signal.throwIfAborted();
      // Cached rejections must not extend the upstream's reset time, and an
      // already-queued call must recheck the cooldown before loading secrets.
      if(this.cooldownUntil>this.now())throw new DiscoveryError(`${this.config.label} is cooling down after a rate limit. No request was sent.`,{
        code:'RATE_LIMITED',retryAfterSeconds:Math.ceil((this.cooldownUntil-this.now())/1000),
        ...(this.cooldownWindow!==undefined?{windowSeconds:this.cooldownWindow}:{}),outcome:'not_sent',
      });
      this.active=context;
      try{
        const invoke=async()=>{
          const binding=this.config.credentialBinding?.();
          if(this.credentialKey!==undefined&&binding!==this.credentialKey&&this.session)await this.retire(this.session);
          try{const session=await this.ensureReady(context);return await operation(session,context);}
          finally{this.credentialKey=this.config.credentialBinding?.();}
        };
        return this.config.withOperation?await this.config.withOperation(context.signal,invoke):await invoke();
      }catch(error){
        const outcome=context.dispatched?'unknown':'not_sent';
        if(this.closed||this.changed)throw this.unavailable(outcome);
        if(context.signal.aborted)throw this.cancelled(context.signal,outcome);
        const safe=remoteFailure(error,this.config.label);
        if(safe.details.code==='RATE_LIMITED'&&safe.details.retryAfterSeconds!==undefined&&safe.details.retryAfterSeconds>0){
          this.cooldownUntil=Math.max(this.cooldownUntil,this.now()+safe.details.retryAfterSeconds*1000);
          this.cooldownWindow=safe.details.windowSeconds;
        }
        throw new DiscoveryError(safe.message,{...safe.details,outcome});
      }finally{this.active=undefined;}
    });
    this.queue=work.then(()=>{this.pending--;},()=>{this.pending--;});
    return waitWithSignal(work,context.signal).catch(error=>{
      const outcome=context.dispatched?'unknown':'not_sent';
      if(this.closed||this.changed)throw this.unavailable(outcome);
      if(context.signal.aborted)throw this.cancelled(context.signal,outcome);throw error;
    });
  }
  discover(signal?:AbortSignal):Promise<Tool[]>{return this.run(undefined,signal,async()=>this.tools);}
  call(name:string,args:Record<string,unknown>,signal:AbortSignal):Promise<CallToolResult>{
    return this.run(name,signal,async(session,context)=>{
      const tool=this.tools.find(tool=>tool.name===name);
      if(!tool)throw new DiscoveryError('Tool is not in the discovered catalogue.',{code:'UNAVAILABLE'});
      if(!compileToolSchema(this.validator,tool.inputSchema)(args).valid)throw new DiscoveryError('Invalid tool arguments.',{code:'UPSTREAM_ERROR'});
      await this.config.beforeCall?.(tool,args,context.signal);
      context.headers=await this.config.headersForCall?.(context.signal);
      context.signal.throwIfAborted();if(this.session!==session||this.closed||this.changed)throw this.unavailable();
      try{
        const result=CallToolResultSchema.parse(await session.client.callTool({name,arguments:args},{signal:context.signal,timeout:this.options.timeoutMs??30_000,
          toolDefinition:tool}));
        this.failures=0;return result;
      }catch(error){
        const failure=remoteFailure(error,this.config.label),code=failure.details.code;
        try{await this.config.onCallFailure?.(failure);}
        catch{this.lost(session);await this.retire(session).catch(()=>{});throw new DiscoveryError('Credential recovery failed. Review the connection before retrying.',{code:'UNAVAILABLE'});}
        if(context.signal.aborted||(this.config.authProvider&&code==='AUTH_REQUIRED')
          ||(!(error instanceof ProtocolError)&&!['AUTH_REQUIRED','FORBIDDEN','RATE_LIMITED'].includes(code))){
          this.lost(session);await this.retire(session).catch(()=>{});
        }
        throw error;
      }
    });
  }
  async close():Promise<void>{
    this.closed=true;this.shutdown.abort();
    if(this.session)void this.retire(this.session).catch(()=>{});
    await this.queue;await Promise.allSettled([...this.cleanup]);
  }
}
