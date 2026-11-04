import { CallToolResultSchema } from "@modelcontextprotocol/core";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client, ProtocolError } from "@modelcontextprotocol/client";
import { compileToolSchema } from './tool-schema.js';
import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import { listAllTools } from './discover-tools.js';
import { DiscoveryError } from './errors.js';
import { waitWithSignal } from './cancellation.js';

export interface ConnectionLifecycle {
  state: 'ready' | 'connecting' | 'backoff' | 'catalogue_changed' | 'closed';
  reconnects: number;
  consecutiveFailures: number;
  retryAfterSeconds?: number;
}

interface Session {
  client: Client;
  transport: StdioClientTransport;
  retired?: Promise<void>;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .filter(([, item]) => item !== undefined).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

function catalogueKey(tools: Tool[]): string {
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) throw new Error('Duplicate tool');
  const validator = new AjvJsonSchemaValidator();
  for (const tool of tools) compileToolSchema(validator, tool.inputSchema);
  return canonical([...tools].sort((a, b) => a.name.localeCompare(b.name)));
}

/** One child at a time. Reconnect before a new call; never replay a dispatched call. */
export class LocalConnection {
  private session?: Session;
  private pending = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private shutdown = new AbortController();
  private cleanup = new Set<Promise<void>>();
  private closed = false;
  private changed = false;
  private connecting = false;
  private ready = false;
  private failures = 0;
  private retryAt = 0;
  private connections = 0;
  private catalogue?: string;
  private tools: Tool[] = [];

  constructor(private config: { label: string; command: string; args: string[]; env: Record<string, string>; protocol?: 'auto' | 'legacy' | '2026-07-28' },
    private options: { now?: () => number; timeoutMs?: number; backoffMs?: number } = {}) {}

  private now() { return (this.options.now ?? Date.now)(); }
  private deadline(signal?: AbortSignal) {
    return AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(this.options.timeoutMs ?? 30_000), ...(signal ? [signal] : [])]);
  }
  status(): ConnectionLifecycle {
    return {
      state: this.closed ? 'closed' : this.changed ? 'catalogue_changed' : this.connecting ? 'connecting' : this.ready ? 'ready' : 'backoff',
      reconnects: Math.max(0, this.connections - 1), consecutiveFailures: this.failures,
      ...(!this.ready && this.retryAt > this.now() ? { retryAfterSeconds: Math.ceil((this.retryAt - this.now()) / 1000) } : {}),
    };
  }
  private unavailable(outcome: 'not_sent' | 'unknown' = 'not_sent'): DiscoveryError {
    if (this.closed) return new DiscoveryError('Connection has been closed.', { code: 'UNAVAILABLE', outcome });
    if (this.changed) return new DiscoveryError(`${this.config.label} tool catalogue changed. Restart Hstack and review tool permissions before calling again.`, {
      code: 'UNAVAILABLE', outcome, recovery: 'restart_hstack',
    });
    const seconds = Math.max(0, Math.ceil((this.retryAt - this.now()) / 1000));
    return new DiscoveryError(`${this.config.label} local MCP is unavailable. ${seconds ? `Retry a new request after ${seconds} seconds.` : 'Check its installation, sign-in and configuration.'} The previous operation was not replayed.`, {
      code: 'UNAVAILABLE', outcome, recovery: 'retry_later', ...(seconds ? { retryAfterSeconds: seconds } : {}),
    });
  }
  private cancelled(signal: AbortSignal, outcome: 'not_sent' | 'unknown') {
    return new DiscoveryError(`Local MCP operation cancelled or timed out. ${outcome === 'unknown' ? 'It may have executed; check the service before trying again.' : 'No tool call was sent.'}`, {
      code: signal.reason?.name === 'TimeoutError' ? 'TIMEOUT' : 'CANCELLED', outcome,
    });
  }
  private retire(session: Session): Promise<void> {
    if (session.retired) return session.retired;
    if (this.session === session) { this.session = undefined; this.ready = false; }
    const work = (async () => {
      try { await session.client.close(); } finally { await session.transport.close(); }
    })();
    session.retired = work;
    this.cleanup.add(work);
    void work.then(() => this.cleanup.delete(work), () => this.cleanup.delete(work));
    return work;
  }
  private lost(session: Session) {
    if (this.session !== session || this.closed || this.changed) return;
    this.ready = false;
    this.failures++;
    this.retryAt = this.now() + Math.min(30_000, (this.options.backoffMs ?? 250) * 2 ** Math.min(this.failures - 1, 20));
    // Never emit raw stderr/protocol errors from a credential-bearing child.
    void this.retire(session).catch(() => {});
  }
  private catalogueChanged(session: Session) {
    if (this.session !== session || this.closed) return;
    this.changed = true;
    void this.retire(session).catch(() => {});
  }
  private async ensureReady(signal: AbortSignal): Promise<Session> {
    if (signal.aborted) throw this.cancelled(signal, 'not_sent');
    if (this.closed || this.changed) throw this.unavailable();
    if (this.session && this.ready) return this.session;
    if (this.retryAt > this.now()) throw this.unavailable();
    // Old child must be fully closed before starting its replacement.
    await Promise.allSettled([...this.cleanup]);
    if (signal.aborted) throw this.cancelled(signal, 'not_sent');
    if (this.closed || this.changed) throw this.unavailable();
    const session: Session = {
      client: new Client({ name: 'hstack-upstream', version: '0' }, {
        versionNegotiation: { mode: this.config.protocol === '2026-07-28' ? { pin: this.config.protocol } : this.config.protocol ?? 'legacy' },
      }),
      // Common Python MCP servers call load_dotenv() during imports. Do not let
      // that silently load unrelated project keys; explicit config can opt out.
      transport: new StdioClientTransport({ command: this.config.command, args: this.config.args,
        env: { PYTHON_DOTENV_DISABLED: '1', ...this.config.env }, stderr: 'ignore' }),
    };
    this.session = session;
    this.connecting = true;
    session.client.onclose = () => this.lost(session);
    session.client.setNotificationHandler('notifications/tools/list_changed', () => this.catalogueChanged(session));
    try {
      await session.client.connect(session.transport, { signal });
      const tools = await listAllTools(session.client, signal);
      const key = catalogueKey(tools);
      if (this.catalogue !== undefined && key !== this.catalogue) {
        this.catalogueChanged(session);
        throw this.unavailable();
      }
      if (signal.aborted) throw this.cancelled(signal, 'not_sent');
      if (this.session !== session || this.closed || this.changed) throw this.unavailable();
      this.catalogue = key;
      this.tools = tools;
      this.ready = true;
      this.connections++;
      return session;
    } catch (error) {
      this.lost(session);
      await this.retire(session).catch(() => {});
      if (signal.aborted) throw this.cancelled(signal, 'not_sent');
      if (error instanceof DiscoveryError) throw error;
      throw this.unavailable();
    } finally { this.connecting = false; }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.pending >= 64) return Promise.reject(new DiscoveryError('Connection request queue is full. Retry later; no request was sent.', {code:'UNAVAILABLE',outcome:'not_sent',recovery:'retry_later'}));
    this.pending++;
    const work = this.queue.then(operation);
    this.queue = work.then(() => {this.pending--;}, () => {this.pending--;});
    return work;
  }

  async discover(signal?: AbortSignal): Promise<Tool[]> {
    const deadline = this.deadline(signal);
    const work = this.enqueue(async () => { await this.ensureReady(deadline); return this.tools; });
    return waitWithSignal(work, deadline);
  }

  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult> {
    if (this.closed) return Promise.reject(this.unavailable());
    // Queue wait, reconnection and operation all share this total budget.
    const deadline = this.deadline(signal);
    let dispatched = false;
    const work = this.enqueue(async () => {
      const session = await this.ensureReady(deadline);
      if (deadline.aborted) throw this.cancelled(deadline, 'not_sent');
      try {
        dispatched = true;
        const result = CallToolResultSchema.parse(await session.client.callTool({ name, arguments: args }, {
          signal: deadline, toolDefinition: this.tools.find((tool) => tool.name === name),
        }));
        this.failures = 0;
        return result;
      } catch (error) {
        // Wire errors can leave the child healthy. SDK/transport failures cannot.
        if (deadline.aborted || !(error instanceof ProtocolError)) {
          this.lost(session);
          await this.retire(session).catch(() => {});
        }
        if (deadline.aborted) throw this.cancelled(deadline, 'unknown');
        if (!this.ready || this.session !== session) throw this.unavailable('unknown');
        throw new DiscoveryError(`${this.config.label} tool request failed. Check the service before trying again; Hstack did not replay the operation.`, {
          code: 'UPSTREAM_ERROR', outcome: 'unknown',
        });
      }
    });
    // Return cancellation immediately, even while the SDK retires an unresponsive child.
    return waitWithSignal(work, deadline).catch((error) => {
      if (deadline.aborted) throw this.cancelled(deadline, dispatched ? 'unknown' : 'not_sent');
      throw error;
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.shutdown.abort();
    if (this.session) void this.retire(this.session).catch(() => {});
    await Promise.allSettled([...this.cleanup]);
  }
}
