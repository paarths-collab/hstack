# Connection recovery

Configured stdio connections stay alive and serialize tool calls. If a child
stops, Hstack marks it unavailable and reconnects **before a new request** after
a short cooldown. It does not repeat the request that lost its response.

Read the `hstack://connections` resource to inspect a local connection's
`lifecycle`: `ready`, `connecting`, `backoff`, `catalogue_changed` or `closed`.
It also reports reconnects, consecutive failures and a retry delay when present.
No command paths, environment values, process IDs or account contents are exposed.

HTTP services (including built-in social adapters, native OAuth and BigQuery)
also reuse one official SDK MCP client per provider. Discovery and subsequent calls
share that client. Calls are serialized with independent total deadlines; the
startup deadline is never retained as the lifetime of later requests. Native OAuth
still reloads credentials and holds the shared filesystem lock through each
operation. External credential changes replace the old session before reconnect;
own refresh keeps a valid session warm.

## What a failed call means

Errors returned by Hstack include `_meta.hstack` with service, code and, for
managed local/reused-HTTP transport failures, `outcome`:

| Outcome | Meaning | Next action |
| --- | --- | --- |
| `not_sent` | Hstack has not sent this tool request. It may have tried initialization/discovery. | Check the error and wait out any retry delay before a new request. |
| `unknown` | The tool request may have executed, but its result could not be verified. | Check the service's state before attempting a write again. |

Cancellation before dispatch never sends the queued call. Cancellation/timeout
after dispatch retires the child or reused HTTP client; Hstack does not assume the upstream operation
was rolled back. An external service may already have completed a mutation.
Normal upstream tool errors/results are returned without restarting a healthy
connection; raw protocol errors and child stderr are hidden from agent logs.

Reconnection uses increasing cooldowns: 250 ms, 500 ms, 1 s, and so on, capped at
30 s. A successful tool call resets the failure count. There is no background
spawn loop: each attempt requires a new request, and concurrent queued requests
share one connection. Queue wait, reconnect and call share the 30-second budget.
Child cleanup can take an additional bounded grace period through the SDK.

For reused HTTP clients, permission/rate-limit errors retain a healthy transport.
Native OAuth sign-in failures retire the session; the SDK retains its standard
authentication challenge handling. Hstack never replays a network failure or
unknown outcome. A supplied Retry-After also
blocks already-queued calls before credential loading or dispatch. Cached cooldown
errors preserve a known quota window without extending its reset time. Network
failure/cancellation retires the client; only a new explicit request can reconnect.
Per-call credential headers are scoped to that request and never enter public
BigQuery discovery. Google HTTP 401 clears the cached access token for the next
explicit operation, without refreshing or replaying the failed operation.

## Changed catalogues require review

On reconnect, Hstack checks the full advertised tool catalogue against the
startup snapshot, including schemas and annotations. Tool order/object key order
alone do not count as a change. A changed catalogue, or an upstream tool-list
notification, stops later calls and reports `recovery: restart_hstack`.

Run `check <id>` to inspect current tool names, review schemas and allowed read
names, then restart Hstack. New tools are never silently admitted to the old
gateway routes, validators or permissions. Even a harmless description change
currently requires this restart; automatic catalogue reload is not implemented.

Write authorization for custom connections uses exact `writeTools` names or the
broader `allowWrites` flag in private
`connections.json`. Built-in social adapters use their per-provider environment
flags. Hstack error guidance now names the applicable setting. Do not enable
writes merely to work around a failed connection.

## Shutdown and limits

SIGINT, SIGTERM and downstream stdin closure cancel startup/in-flight requests
and close owned upstream children. Incoming initialization messages are buffered
while discovery runs, so early client input is preserved. The SDK gives local
children a bounded grace period, then terminates an unresponsive child.

This manages local processes and the reused HTTP clients described above. A
provider that failed its **initial** startup discovery is still omitted until
Hstack restarts. OAuth refresh
recovery, stale credential locks and remote revocation are described in
[OAuth setup](oauth.md). No guarantee applies to an OS hard kill, externally
detached descendants or operations already accepted by a remote service.

## Evidence

Real OS child-process fixtures cover idle crashes, response loss after a mutation,
concurrent recovery, repeated startup failure/backoff, queued cancellation,
timeouts, schema/annotation changes, tool-list notifications and stubborn-child
termination. Real Hstack stdio launch tests cover buffered initialization, EOF
after startup, and SIGTERM/EOF while discovery hangs. These use local synthetic
MCP servers, not vendor account operations.

Reused-HTTP fixtures also cover legacy/modern protocol paths, scoped credential
rotation, unchanged startup deadlines, queued cancellation and rate limits,
backoff/reconnect, catalogue changes and shutdown. The actual Hstack stdio and
installed Hermes BigQuery fixture now use five MCP POSTs for two reads, matching
the direct fixture's MCP count (previously nine). This is synthetic request-count
evidence, not a latency, billing or model-cost benchmark.
