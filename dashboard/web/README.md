# hstack/dashboard/web

Next.js 15 + Tailwind 4 + shadcn/ui rebuild of the hstack dashboard.

## Routes

- `/` — SpiralAnimation welcome screen (canvas, GSAP). Click **Enter** → `/setup`.
- `/setup` — Hero195 first-run guide. Tabs for macOS/Linux, Windows, Docker. Animated `BorderBeam` install card. Optional provider-key field.
- `/dashboard` — Tabs: **Visualize** (live pixel office, ported from `nextjs-handoff`), Overview, Sessions, Cron.

## Run

```bash
cd dashboard/web
npm install
npm run dev
```

Then open `http://localhost:3000`. The dashboard proxies `/api/*` to `HERMES_BASE` (default `http://127.0.0.1:9119`) — set the env var to point at a remote tunnel.

## Layout

```
app/
  page.tsx           ← spiral welcome
  setup/page.tsx     ← Hero195
  dashboard/page.tsx ← tabs + visualize
  globals.css        ← Tailwind 4 theme + office.css import
  office.css         ← pixel-office world styles
components/
  ui/                ← shadcn primitives (button, card, tabs, input, label) + spiral, hero-195, border-beam, tracing-beam
  office/            ← Office.tsx + sim.ts (live activity, useOfficeSim)
lib/
  utils.ts           ← cn()
  hermes.ts          ← GET-only Hermes API client, TOOLS catalog, toolMeta()
```

## Replaces

This is intended to replace both `prototype/` (zero-build) and `nextjs-handoff/` (earlier scaffold) once verified. Keep the old folders until then.
