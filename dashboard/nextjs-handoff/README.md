# Atlas · hstack — Hermes Agent dashboard (Next.js handoff)

A **read-only** monitoring dashboard for a self-hosted **Hermes Agent**, with a
WorkAdventure-style pixel **Visualize** office. Built on **Next.js (App Router) +
TypeScript + Tailwind v4 + shadcn/ui**, themed to the cream/vermilion design from
the reference. A togglable **pixel** skin re-skins the whole app.

This package is meant to be handed to **Claude Code**. It runs as-is, and mirrors
the approved HTML prototype 1:1 (same sections, same visual system, same office).

---

## 1. Run it

```bash
npm install
cp .env.example .env.local          # set HERMES_BASE (defaults to the localhost tunnel)
npm run dev                          # http://localhost:3000
```

With no agent reachable you get clearly-labelled **DEMO DATA** — the page never
looks broken. Point it at a real agent by tunnelling :9119:

```bash
ssh -L 9119:127.0.0.1:9119 you@your-vps
```

## 2. shadcn project structure

Already wired the standard way:

```
app/            layout.tsx · page.tsx (Tabs shell) · globals.css · office.css
components/ui/  card · button · tabs · input · label · border-beam   ← the components you provided
components/dashboard/sections.tsx   Overview · Channels · Schedule · Ledger · Usage · About
components/office/                  sim.ts (simulation) · Office.tsx (Visualize world)
lib/            utils.ts (cn) · hermes.ts (GET-only API client + demo data)
```

`components/ui` is the canonical shadcn location and `@/*` path aliases are set in
`tsconfig.json`, so `npx shadcn@latest add <component>` drops new primitives in the
right place and `import { cn } from "@/lib/utils"` resolves.

### Components included (from your spec)
- **Card / Button / Tabs / Input / Label** — shadcn primitives, restyled to the
  cream/vermilion tokens (pill buttons, rounded cards).
- **BorderBeam** (`dillionverma/border-beam`) — used on the live "Gateway" hero card
  while the agent is online. Its keyframe lives in `globals.css` (`--animate-border-beam`).
- *TracingBeam* from your spec isn't used here (it needs `framer-motion` and suits long
  scroll pages); add it with `npm i framer-motion` if you want it later.

Install the radix peers if you regenerate from scratch:
```bash
npm i @radix-ui/react-slot @radix-ui/react-tabs @radix-ui/react-label class-variance-authority lucide-react
```

## 3. Security model (do not weaken)
- The data layer (`lib/hermes.ts`) defines **only a GET helper** — no POST/PUT/DELETE
  exists, so no mutating endpoint from the API contract can be called from the UI.
- The browser only calls **same-origin `/api/*`**; `next.config.ts` rewrites that to
  `HERMES_BASE`, so there's **no CORS** and the token (if any) never reaches the client.
- The upstream dashboard has **no auth** and binds to 127.0.0.1 — reach it over an SSH
  tunnel, or front it with Caddy/Traefik (HTTPS + basic-auth). **Never expose :9119 raw.**
- Pin Hermes **v0.15.2** (current stable; v0.15.0 had a loopback dashboard reload loop, fixed in v0.15.1).

## 4. Endpoints used (all ✅ verified to exist; response shapes ⚠️ inferred)
| Panel | Endpoint | Poll |
|---|---|---|
| Hero / health / platforms / sessions | `GET /api/status` | 5s |
| Activity ledger | `GET /api/sessions` | 10s |
| Schedule | `GET /api/cron/jobs` | 30s |
| Usage & cost | `GET /api/analytics/usage?days=7` | 60s |
| Capability probe (8642, optional) | `GET /v1/capabilities` | startup |

> Field names are **not** officially documented. `lib/hermes.ts` reads defensively
> with fallbacks — **log one real response and adjust the normalisers** in `readAll()`.

## 5. The Visualize office
`components/office/sim.ts` is a pure client-side simulation (no requests): rooms are
Hermes **toolsets** (Web Search, Memory, Shell, Code, Channels, Calendar, Gateway,
Planner, Standby); agents are **Atlas + its sub-agents** that walk between rooms, sit
at desks, and run tasks whose **tool/command logs** scroll on the monitors and stream
into the side feed. Click an agent for its live log. To drive it from real activity,
map `GET /api/sessions` entries onto tasks in `sim.ts` (`chooseTask`).

## 6. Theming
All color/spacing tokens are CSS variables in `app/globals.css` (`:root`) with a
`html.pixel` override for the retro skin (also re-skins the office via `office.css`).
Tailwind v4 maps them through `@theme inline`, so `bg-card`, `text-primary`, etc.
follow the palette. Change the accent in one place (`--accent`).
