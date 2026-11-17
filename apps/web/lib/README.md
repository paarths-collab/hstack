# Local account database

The Next.js server uses Better Auth email/password sessions and a local SQLite
database. Copy `apps/web/.env.example` to `.env.local`, replace
`BETTER_AUTH_SECRET` with a random value of at least 32 bytes, and run the
server from `apps/web`. The default database is `.data/agent-builder.sqlite`.
Set `AGENT_BUILDER_DB_PATH` to an absolute path on persistent storage when
packaging or deploying the server. SQLite and its WAL files need writable
storage and must not be served publicly.

From `apps/web`, run `node --env-file=.env.local lib/migrate.mjs` to initialize
the Better Auth and app tables. The server also initializes them on its first
request for a single-process local setup. Run the migration once before starting
multiple production processes; the first-request path is not a coordinated
multi-instance migration. Keep the secret and database across restarts, and
back up the database before upgrades.

Account storage accepts validated agent drafts and non-secret connection setup
notes only. It does not store provider credentials, connect an account, or run
workflows. Saved records currently use last-write-wins updates. Email
verification and password reset are not configured in this local MVP.
