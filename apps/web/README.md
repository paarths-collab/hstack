# Agent Builder website

The public display name is “Agent Builder” in `app/site-config.js`. Repository and package IDs remain unchanged.

## Run locally

Use Node.js 26 or newer for the built-in SQLite driver used by this app.

1. Run `npm ci` in this directory.
2. Copy `.env.example` to `.env.local` and replace `BETTER_AUTH_SECRET` with a random secret of at least 32 characters. Set `BETTER_AUTH_URL` to the exact local origin you will use (for example `http://localhost:3000`). Keep `.env.local` private.
3. Run `npm run dev` and open the configured origin and `/builder/`.

`npm run build` creates a production Next.js build. `npm run start` serves it with the account API. The app is no longer a static export. Account data is stored in `.data/agent-builder.sqlite` by default; set `AGENT_BUILDER_DB_PATH` to an absolute, durable, writable location to move it. Keep it private. For live backups, use SQLite's online backup API or a consistent volume snapshot; copying only the main `.sqlite` file while the app is running can miss data still in its WAL file.

`npm run test:e2e` builds and runs the browser suite against a separate temporary database. It checks the editor, export/install path, account and connection configuration flow, and homepage interactions.

## What works

- Start from Founder Assistant, Research Assistant, Personal Planner, or a blank agent.
- Edit instructions, tool scopes, five workflow presets, and custom workflows with steps and schedules.
- Keep a guest draft in this browser. An optional account can save agent configurations and non-secret app setup notes on this server.
- Export neutral JSON and project ZIP files for Claude Code, Codex, or Hermes. The website remains LLM-free.
- Use the local installer and doctor in `packages/agent-builder-adapters/cli.js` to install and check exported files.

App connection entries are editable **setup configurations**, not live OAuth connections. Selecting GitHub or Telegram does not authorize that account or upload credentials; the user connects tools in their local harness after export. Do not enter tokens or passwords in agent instructions, app notes, or URLs.

## Hosting boundary

The included SQLite database needs a persistent disk and a long-running Node host. It is not suitable for an ephemeral serverless filesystem such as Vercel Functions. Use a durable external database adapter before that kind of deployment. Email verification and password reset delivery are not configured yet, so this local MVP should not be exposed as a public account service without those additions.

The older one-workflow Hermes Daily Repository Brief remains in `apps/stack-builder/`.
