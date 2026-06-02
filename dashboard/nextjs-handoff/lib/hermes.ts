// lib/hermes.ts — READ-ONLY data layer for the Hermes :9119 dashboard API.
// SECURITY: only GET is defined here. No POST/PUT/DELETE helper exists, so no
// mutating endpoint from the contract can be called from the UI. Requests go to
// same-origin /api/* which next.config.ts proxies to HERMES_BASE (default the
// localhost tunnel). Field names are NOT officially documented — every read is
// defensive and falls back to clearly-labelled DEMO data.

export type Platform = { name: string; connected: boolean };
export type Status = {
  version?: string;
  gateway?: { running?: boolean } | string;
  uptime_seconds?: number;
  sessions?: { active?: number };
  health?: { cpu?: number; mem?: number; disk?: number };
  memory?: { user?: number; user_max?: number; agent?: number; agent_max?: number };
  capabilities?: Record<string, "ok" | "degraded" | "off">;
  platforms?: Platform[];
};
export type CronJob = { id?: string; name?: string; schedule?: string; next_run?: string; paused?: boolean };
export type Session = { id?: string; updated?: string; platform?: string; summary?: string; tokens?: number; tool?: string };
export type Usage = {
  totals?: { messages?: number; tokens?: number; cost?: number; cache_hit_rate?: number };
  daily?: { day?: string; messages: number; cost: number; tokens?: number }[];
};
export type Bundle = { live: boolean; status: Status; cron: CronJob[]; sessions: Session[]; usage: Usage };

async function GET<T>(path: string): Promise<T> {
  const r = await fetch(path, { method: "GET", cache: "no-store" });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json() as Promise<T>;
}

const asArray = <T,>(x: unknown, ...keys: string[]): T[] => {
  if (Array.isArray(x)) return x as T[];
  for (const k of keys) if (x && Array.isArray((x as Record<string, unknown>)[k])) return (x as Record<string, T[]>)[k];
  return [];
};

export async function readAll(): Promise<Bundle> {
  try {
    const status = await GET<Status>("/api/status");
    const [cron, sessions, usage] = await Promise.all([
      GET<unknown>("/api/cron/jobs").catch(() => DEMO.cron),
      GET<unknown>("/api/sessions").catch(() => DEMO.sessions),
      GET<Usage>("/api/analytics/usage?days=7").catch(() => DEMO.usage),
    ]);
    return {
      live: true,
      status,
      cron: asArray<CronJob>(cron, "jobs", "items").length ? asArray<CronJob>(cron, "jobs", "items") : DEMO.cron,
      sessions: asArray<Session>(sessions, "sessions", "items").length ? asArray<Session>(sessions, "sessions", "items") : DEMO.sessions,
      usage: usage && (usage.totals || usage.daily) ? { totals: usage.totals ?? DEMO.usage.totals, daily: usage.daily ?? DEMO.usage.daily } : DEMO.usage,
    };
  } catch {
    return { live: false, ...DEMO };
  }
}

// Probe the 8642 API server (Bearer-auth) at startup — learn the running surface.
export async function probeCapabilities(): Promise<{ live: boolean; toolsets: string[]; models?: string[] }> {
  return { live: false, toolsets: DEMO.toolsets }; // wire to /v1/capabilities if API_SERVER is exposed
}

// Hermes' built-in default toolsets (tool names per the built-in tools reference).
export const TOOLS = [
  { id: "web", label: "Web", glyph: "search", cmd: "web_search · web_extract" },
  { id: "browser", label: "Browser", glyph: "radio", cmd: "browser_navigate · _vision" },
  { id: "terminal", label: "Terminal & Files", glyph: "terminal", cmd: "terminal · read_file · patch" },
  { id: "code", label: "Code", glyph: "code", cmd: "execute_code" },
  { id: "memory", label: "Memory", glyph: "database", cmd: "memory · session_search" },
  { id: "channels", label: "Channels", glyph: "mail", cmd: "send_message" },
  { id: "media", label: "Media", glyph: "eye", cmd: "vision · image_gen · tts" },
  { id: "cron", label: "Scheduler", glyph: "cal", cmd: "cronjob" },
  { id: "orchestration", label: "Orchestration", glyph: "share", cmd: "todo · delegate_task" },
  { id: "mcp", label: "Integrations · MCP", glyph: "cpu", cmd: "mcp · ha_*" },
];

// Live capability → display metadata. Unknown ids (a newly-added tool / MCP server)
// are prettified and flagged, so the grid self-improves with whatever the agent reports.
const ALIAS: Record<string, string> = { scheduler: "cron", files: "terminal", file: "terminal", search: "web", tts: "media", voice: "media", vision: "media", image_gen: "media", skills: "orchestration", todo: "orchestration", delegation: "orchestration", code_execution: "code", homeassistant: "mcp", home_assistant: "mcp" };
const TOOL_BY_ID: Record<string, (typeof TOOLS)[number]> = Object.fromEntries(TOOLS.map((t) => [t.id, t]));
export function toolMeta(id: string): { label: string; glyph: string; known: boolean } {
  const t = TOOL_BY_ID[ALIAS[id] || id];
  if (t) return { label: t.label, glyph: t.glyph, known: true };
  return { label: String(id).replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), glyph: "cpu", known: false };
}

export const DEMO: { status: Status; cron: CronJob[]; sessions: Session[]; usage: Usage; toolsets: string[] } = {
  status: {
    version: "0.15.2", gateway: { running: true }, uptime_seconds: 1123200, sessions: { active: 3 },
    health: { cpu: 24, mem: 61, disk: 43 }, memory: { user: 1361, user_max: 1375, agent: 1980, agent_max: 2200 },
    capabilities: { Vision: "degraded", "Web search": "ok", Compression: "ok", Voice: "off" },
    platforms: [
      { name: "Telegram", connected: true }, { name: "Discord", connected: true },
      { name: "WhatsApp", connected: false }, { name: "Slack", connected: false },
    ],
  },
  cron: [
    { id: "c1", name: "Daily news briefing", schedule: "every 1d", next_run: "tomorrow 08:00", paused: false },
    { id: "c2", name: "Backup memory → GitHub", schedule: "every 1d", next_run: "tonight 00:00", paused: false },
    { id: "c3", name: "Server health check", schedule: "every 6h", next_run: "in 2h", paused: false },
    { id: "c4", name: "Weekly cost report", schedule: "every 7d", next_run: "Mon 09:00", paused: true },
  ],
  sessions: [
    { id: "s1", updated: "2026-06-01 14:32", platform: "Telegram", summary: "Summarized 4 unread emails", tokens: 3200, tool: "send_message" },
    { id: "s2", updated: "2026-06-01 14:05", platform: "Discord", summary: "Drafted a blog outline", tokens: 8100, tool: "web_search" },
    { id: "s3", updated: "2026-06-01 13:21", platform: "Telegram", summary: "Researched 3 competitors", tokens: 12400, tool: "web_search" },
    { id: "s4", updated: "2026-06-01 12:40", platform: "Discord", summary: "Fixed a failing cron job", tokens: 5400, tool: "terminal" },
    { id: "s5", updated: "2026-06-01 11:10", platform: "Telegram", summary: "Morning briefing delivered", tokens: 2600, tool: "memory" },
    { id: "s6", updated: "2026-06-01 09:50", platform: "Telegram", summary: "Searched past sessions for an invoice", tokens: 1900, tool: "session_search" },
  ],
  usage: {
    totals: { messages: 212, tokens: 1840000, cost: 3.74, cache_hit_rate: 71 },
    daily: [
      { day: "Mon", messages: 18, cost: 0.3, tokens: 210000 }, { day: "Tue", messages: 31, cost: 0.55, tokens: 290000 },
      { day: "Wed", messages: 24, cost: 0.41, tokens: 240000 }, { day: "Thu", messages: 40, cost: 0.78, tokens: 350000 },
      { day: "Fri", messages: 29, cost: 0.52, tokens: 260000 }, { day: "Sat", messages: 44, cost: 0.81, tokens: 300000 },
      { day: "Sun", messages: 26, cost: 0.37, tokens: 190000 },
    ],
  },
  toolsets: ["web", "browser", "terminal", "code", "memory", "channels", "media", "cron", "orchestration"],
};
