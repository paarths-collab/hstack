/* ════════════════════════════════════════════════════════════════════
   data.js — read-only data layer for the Atlas hstack dashboard.
   SECURITY MODEL (do not weaken):
     • Only ever issues GET requests. No POST/PUT/DELETE is defined here.
     • Mutating endpoints from the API contract are deliberately NOT wired.
     • API_BASE defaults to "" (same origin) — reach :9119 over an SSH tunnel
       or behind an HTTPS+password reverse proxy. Never expose :9119 raw.
     • Unreachable agent → labelled DEMO data, so the page never looks broken.
   Field names in responses are NOT officially documented — every read is
   defensive with graceful fallbacks, and /v1/capabilities is probed at startup.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  const CFG = {
    API_BASE: "",          // "" = same origin · or "http://127.0.0.1:9119" over a tunnel
    API_SERVER_BASE: "",   // 8642 server (liveness + capability probe); "" = disabled
    TOKEN: "",             // Bearer for the 8642 API server only
    POLL: { status: 5000, sessions: 10000, cron: 30000, usage: 60000 },
  };

  // GET-only fetch. There is intentionally no post/put/delete helper anywhere.
  async function GET(path, base) {
    const root = base != null ? base : CFG.API_BASE;
    const headers = CFG.TOKEN && base === CFG.API_SERVER_BASE ? { Authorization: "Bearer " + CFG.TOKEN } : {};
    const r = await fetch(root + path, { method: "GET", headers, cache: "no-store" });
    if (!r.ok) throw new Error(path + " → " + r.status);
    return r.json();
  }

  // ── DEMO DATA (used as fallback; clearly flagged in the UI) ──
  const now = new Date();
  const hhmm = (mAgo) => {
    const d = new Date(now.getTime() - mAgo * 60000);
    return d.toTimeString().slice(0, 5);
  };

  const DEMO = {
    status: {
      version: "0.15.2",
      gateway: { running: true },
      uptime_seconds: 1123200, // ~13 days
      sessions: { active: 3 },
      health: { cpu: 24, mem: 61, disk: 43 },
      memory: { user: 1361, user_max: 1375, agent: 1980, agent_max: 2200 },
      capabilities: { Vision: "degraded", "Web search": "ok", Compression: "ok", Voice: "off" },
      platforms: [
        { name: "Telegram", connected: true },
        { name: "Discord", connected: true },
        { name: "WhatsApp", connected: false },
        { name: "Slack", connected: false },
      ],
    },
    cron: [
      { id: "c1", name: "Daily news briefing", schedule: "every 1d", next_run: "tomorrow 08:00", paused: false },
      { id: "c2", name: "Backup memory → GitHub", schedule: "every 1d", next_run: "tonight 00:00", paused: false },
      { id: "c3", name: "Server health check", schedule: "every 6h", next_run: "in 2h", paused: false },
      { id: "c4", name: "Weekly cost report", schedule: "every 7d", next_run: "Mon 09:00", paused: true },
    ],
    sessions: [
      { id: "s1", updated: now.toISOString().slice(0, 10) + " " + hhmm(2), platform: "Telegram", summary: "Summarized 4 unread emails", tokens: 3200, tool: "send_message" },
      { id: "s2", updated: now.toISOString().slice(0, 10) + " " + hhmm(34), platform: "Discord", summary: "Drafted a blog outline", tokens: 8100, tool: "web_search" },
      { id: "s3", updated: now.toISOString().slice(0, 10) + " " + hhmm(78), platform: "Telegram", summary: "Researched 3 competitors", tokens: 12400, tool: "web_search" },
      { id: "s4", updated: now.toISOString().slice(0, 10) + " " + hhmm(120), platform: "Discord", summary: "Fixed a failing cron job", tokens: 5400, tool: "terminal" },
      { id: "s5", updated: now.toISOString().slice(0, 10) + " " + hhmm(190), platform: "Telegram", summary: "Morning briefing delivered", tokens: 2600, tool: "memory" },
      { id: "s6", updated: now.toISOString().slice(0, 10) + " " + hhmm(240), platform: "Telegram", summary: "Searched past sessions for an invoice", tokens: 1900, tool: "session_search" },
    ],
    usage: {
      totals: { messages: 212, tokens: 1840000, cost: 3.74, cache_hit_rate: 71 },
      daily: [
        { day: "Mon", messages: 18, cost: 0.30, tokens: 210000 },
        { day: "Tue", messages: 31, cost: 0.55, tokens: 290000 },
        { day: "Wed", messages: 24, cost: 0.41, tokens: 240000 },
        { day: "Thu", messages: 40, cost: 0.78, tokens: 350000 },
        { day: "Fri", messages: 29, cost: 0.52, tokens: 260000 },
        { day: "Sat", messages: 44, cost: 0.81, tokens: 300000 },
        { day: "Sun", messages: 26, cost: 0.37, tokens: 190000 },
      ],
    },
    capabilitiesProbe: {
      version: "0.15.2",
      models: ["claude-sonnet", "deepseek-v4", "gpt-4o-mini"],
      toolsets: ["web", "browser", "terminal", "code", "memory", "channels", "media", "cron", "orchestration"],
      features: { runs: true, chat: true, sse: true },
    },
  };

  // Hermes' built-in default toolsets — drives the pixel office "rooms" and the
  // "Available toolsets" grid. Tool names follow Hermes' built-in tools reference.
  const TOOLS = [
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

  // Tools / slash commands the agent works with (read-only display only).
  const COMMANDS = [
    "web_search", "web_extract", "browser_navigate", "terminal", "read_file",
    "patch", "execute_code", "memory", "session_search", "send_message",
    "vision_analyze", "image_generate", "text_to_speech", "cronjob",
    "todo", "delegate_task", "mcp", "ha_call",
  ];

  // ── Aggregated read with graceful fallback. Returns {live:boolean, ...} ──
  async function readAll() {
    try {
      const status = await GET("/api/status");
      const [cron, sessions, usage] = await Promise.all([
        GET("/api/cron/jobs").catch(() => DEMO.cron),
        GET("/api/sessions").catch(() => DEMO.sessions),
        GET("/api/analytics/usage?days=7").catch(() => DEMO.usage),
      ]);
      return { live: true, status, cron: norm.cron(cron), sessions: norm.sessions(sessions), usage: norm.usage(usage) };
    } catch (e) {
      return { live: false, status: DEMO.status, cron: DEMO.cron, sessions: DEMO.sessions, usage: DEMO.usage };
    }
  }

  // Probe /v1/capabilities at startup (8642) — learn what the running build supports.
  async function probeCapabilities() {
    if (!CFG.API_SERVER_BASE) return { live: false, ...DEMO.capabilitiesProbe };
    try {
      const c = await GET("/v1/capabilities", CFG.API_SERVER_BASE);
      return { live: true, ...c };
    } catch (e) {
      return { live: false, ...DEMO.capabilitiesProbe };
    }
  }

  // Defensive normalisers — handle the documented "could be array OR {items:[]}" cases.
  const norm = {
    cron: (c) => (Array.isArray(c) ? c : c.jobs || c.items || DEMO.cron),
    sessions: (s) => (Array.isArray(s) ? s : s.sessions || s.items || DEMO.sessions),
    usage: (u) => {
      if (!u) return DEMO.usage;
      return { totals: u.totals || u, daily: u.daily || DEMO.usage.daily };
    },
    logs: (l) => (Array.isArray(l) ? l : l.lines || []),
  };

  // Look up display metadata for a toolset id. Known toolsets use the catalog above;
  // a NEW / unknown tool (e.g. a freshly-added MCP server) is prettified and flagged
  // so the dashboard "self-improves" — whatever the live agent reports gets a tile.
  const ALIAS = { scheduler: "cron", files: "terminal", file: "terminal", search: "web", tts: "media", voice: "media", vision: "media", image_gen: "media", skills: "orchestration", todo: "orchestration", delegation: "orchestration", code_execution: "code", homeassistant: "mcp", home_assistant: "mcp" };
  const TOOL_BY_ID = Object.fromEntries(TOOLS.map((t) => [t.id, t]));
  function prettify(id) { return String(id).replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()); }
  function toolMeta(id) {
    const canon = ALIAS[id] || id;
    const t = TOOL_BY_ID[canon];
    if (t) return { label: t.label, glyph: t.glyph, known: true };
    return { label: prettify(id), glyph: "cpu", known: false };
  }

  window.HData = { CFG, GET, DEMO, TOOLS, COMMANDS, readAll, probeCapabilities, norm, toolMeta };
})();
