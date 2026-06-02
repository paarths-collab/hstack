// office-sim.jsx — Hermes agent office simulation (read-only, self-improving).
// Rooms are NOT hardcoded: they are built from the agent's LIVE capabilities
// (the toolsets reported by /v1/capabilities + /api/status). Add a new tool or
// MCP server to your agent and a new room appears here automatically — same in
// the normal dashboard's toolset grid. Purely client-side; issues NO requests.

// ───────── TOOLSET CATALOG ─────────
// Known Hermes default toolsets → how to render + what activity to show.
// Anything NOT in here (a new tool / MCP server) still gets a room via a
// generic template, so the office "self-improves" as the agent grows.
const CATALOG = {
  orchestration: { name: 'Orchestration', tag: 'delegate_task', tint: 'tint-amber', color: '#c2851b', kind: 'sync', infra: true,
    tasks: [
      { kind: 'sync', title: 'Plan next actions · todo', bubbles: ['todo', 'planning…', '3 queued'], log: [['todo', 'review goals'], ['plan', 'queued 3 tasks']] },
      { kind: 'sync', title: 'Delegate to a sub-agent', bubbles: ['delegate_task', '→ sub-agent', 'dispatched'], log: [['delegate_task', 'assign work'], ['ok', 'sub-agent on it']] },
    ] },
  gateway: { name: 'Gateway · Health & Cron', tag: '/status', tint: 'tint-slate', color: '#4a5060', infra: true,
    tasks: [
      { kind: 'health', title: 'Gateway health · /status', bubbles: ['GET /api/status', '🟢 running'], log: [['GET', '/api/status'], ['ok', 'running · 13d'], ['cpu', '24% · mem 61%']] },
      { kind: 'health', title: 'Tail gateway logs', bubbles: ['GET /api/logs', 'reading 50…'], log: [['GET', '/api/logs'], ['ok', 'no errors']] },
      { kind: 'schedule', title: 'Schedule a job · cronjob', bubbles: ['cronjob', 'every 1d', 'queued'], log: [['cronjob', '0 8 * * *'], ['ok', 'briefing @ 08:00']] },
    ] },
  web: { name: 'Web', tag: 'web_search', tint: 'tint-blue', color: '#2a6fdb',
    tasks: [
      { kind: 'read', title: 'Search the web · web_search', bubbles: ['web_search', 'querying…', '8 results'], log: [['web_search', '"ai agents"'], ['GET', '8 results'], ['ok', 'ranked top 3']] },
      { kind: 'read', title: 'Extract a page · web_extract', bubbles: ['web_extract', 'reading…'], log: [['web_extract', 'url …/post'], ['ok', 'clean text']] },
    ] },
  browser: { name: 'Browser', tag: 'browser_navigate', tint: 'tint-teal', color: '#1f8a8a',
    tasks: [
      { kind: 'browse', title: 'Drive the browser · browser_navigate', bubbles: ['browser_navigate', 'loading…'], log: [['browser_navigate', 'example.com'], ['ok', 'page ready']] },
      { kind: 'browse', title: 'Read the page · browser_vision', bubbles: ['browser_snapshot', 'browser_vision'], log: [['browser_snapshot', 'dom'], ['browser_vision', 'screenshot'], ['ok', 'understood']] },
    ] },
  terminal: { name: 'Terminal & Files', tag: 'terminal', tint: 'tint-slate', color: '#6c7282',
    tasks: [
      { kind: 'launch', title: 'Run a command · terminal', bubbles: ['terminal', '$ ./backup.sh', 'done ✓'], log: [['terminal', './backup.sh'], ['git', 'commit + push'], ['ok', 'exit 0']] },
      { kind: 'update', title: 'Edit a file · read_file + patch', bubbles: ['read_file', 'patch', 'saved'], log: [['read_file', 'config.yaml'], ['patch', '+3 -1'], ['ok', 'written']] },
    ] },
  code: { name: 'Code', tag: 'execute_code', tint: 'tint-green', color: '#1f8a5b',
    tasks: [
      { kind: 'create', title: 'Run code · execute_code', bubbles: ['execute_code', 'def main()…', 'ran ✓'], log: [['execute_code', 'python'], ['run', 'exit 0'], ['ok', 'output ready']] },
    ] },
  memory: { name: 'Memory & Recall', tag: 'memory', tint: 'tint-violet', color: '#7a5ae0',
    tasks: [
      { kind: 'enrich', title: 'Recall context · memory', bubbles: ['memory', 'recalling…'], log: [['memory', 'user'], ['ok', '1361/1375 chars']] },
      { kind: 'enrich', title: 'Search past chats · session_search', bubbles: ['session_search', 'searching…'], log: [['session_search', '"invoice"'], ['ok', '3 hits']] },
    ] },
  channels: { name: 'Channels & Delivery', tag: 'send_message', tint: 'tint-orange', color: '#d4493a',
    tasks: [
      { kind: 'reply', title: 'Reply on Telegram · send_message', bubbles: ['send_message', 'tone: warm', 'Sent ✓'], log: [['draft', 'warm'], ['send_message', 'telegram'], ['ok', 'message sent']] },
      { kind: 'watch', title: 'Watch channels for replies', bubbles: ['list_chats', '👀 watching…'], log: [['GET', '/api/sessions'], ['poll', 'every 8s'], ['ok', 'inbox idle']] },
    ] },
  media: { name: 'Media', tag: 'image_generate', tint: 'tint-rose', color: '#c2851b',
    tasks: [
      { kind: 'media', title: 'Analyze an image · vision_analyze', bubbles: ['vision_analyze', 'looking…'], log: [['vision_analyze', 'photo.jpg'], ['ok', 'described']] },
      { kind: 'media', title: 'Generate an image · image_generate', bubbles: ['image_generate', 'painting…', '🖼️ ✓'], log: [['image_generate', 'prompt'], ['ok', '1 image']] },
      { kind: 'media', title: 'Speak a reply · text_to_speech', bubbles: ['text_to_speech', '🔊'], log: [['text_to_speech', 'reply'], ['ok', 'audio']] },
    ] },
  mcp: { name: 'Integrations · MCP', tag: 'mcp', tint: 'tint-amber', color: '#e3a52a',
    tasks: [
      { kind: 'mcp', title: 'Call an MCP tool', bubbles: ['mcp', 'tool call…', '✓'], log: [['mcp', 'server: github'], ['call', 'list_prs'], ['ok', '4 PRs']] },
      { kind: 'mcp', title: 'Control devices · Home Assistant', bubbles: ['ha_call', 'lights…', 'done'], log: [['ha_states', 'get'], ['ha_call', 'light.on'], ['ok', 'living room']] },
    ] },
};

// Default toolset list when there is no live agent (demo) — ordered for a tidy layout.
const DEFAULT_TOOLSETS = ['web', 'browser', 'media', 'memory', 'terminal', 'channels', 'code', 'mcp', 'cron', 'orchestration'];
// Aliases fold related capability ids onto a canonical room (so a live "cron" or "vision" doesn't make a bare duplicate room).
const ALIASES = { cron: 'gateway', scheduler: 'gateway', files: 'terminal', file: 'terminal', search: 'web', tts: 'media', voice: 'media', vision: 'media', image_gen: 'media', skills: 'orchestration', todo: 'orchestration', delegation: 'orchestration', code_execution: 'code', homeassistant: 'mcp', home_assistant: 'mcp' };

function prettify(id) { return String(id).replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); }
function catalogFor(id) {
  if (CATALOG[id]) return CATALOG[id];
  // a NEW / unknown tool — generate a room template on the fly (self-improving)
  return { name: prettify(id), tag: id, tint: 'tint-teal', color: '#8a7bd8', _generated: true,
    tasks: [{ kind: 'mcp', title: `Run ${prettify(id)}`, bubbles: [id, 'running…', '✓'], log: [[id, 'call'], ['ok', 'done']] }] };
}

// ───────── AUTO-LAYOUT (world 1600×1000) ─────────
const HUB = { x: 620, y: 380, w: 360, h: 240 };             // center; Orchestration lives here
const HUBC = { x: HUB.x + HUB.w / 2, y: HUB.y + HUB.h / 2 }; // 800,500

function distribute(n) {
  const cap = { top: 4, bottom: 4, left: 2, right: 2 };
  while (cap.top + cap.bottom + cap.left + cap.right < n) { cap.top++; cap.bottom++; if (cap.top + cap.bottom + cap.left + cap.right < n) { cap.left++; cap.right++; } }
  const counts = { top: 0, bottom: 0, left: 0, right: 0 };
  const seq = ['top', 'bottom', 'left', 'right'];
  let placed = 0, i = 0;
  while (placed < n && i < 9999) { const b = seq[i % 4]; if (counts[b] < cap[b]) { counts[b]++; placed++; } i++; }
  return counts;
}
function bandRects(band, count) {
  if (!count) return [];
  const GAP = 24, M = 40;
  if (band === 'top' || band === 'bottom') {
    const y = band === 'top' ? 40 : 710, h = 250, exitY = band === 'top' ? 318 : 682;
    const w = (1520 - GAP * (count - 1)) / count;
    return Array.from({ length: count }, (_, i) => { const x = M + i * (w + GAP); return { x: Math.round(x), y, w: Math.round(w), h, exit: { x: Math.round(x + w / 2), y: exitY } }; });
  }
  const x = band === 'left' ? 40 : 1280, w = 300, top = 356, bandH = 308, exitX = band === 'left' ? 358 : 1242;
  const h = (bandH - GAP * (count - 1)) / count;
  return Array.from({ length: count }, (_, i) => { const y = top + i * (h + GAP); return { x, y: Math.round(y), w, h: Math.round(h), exit: { x: exitX, y: Math.round(y + h / 2) } }; });
}
function desksFor(rect, pfx) {
  const { x, y, w, h } = rect;
  const cx = [Math.round(x + w * 0.30), Math.round(x + w * 0.70)];
  const ry = [Math.round(y + h * 0.40), Math.round(y + h * 0.74)];
  return [
    { id: pfx + '1', x: cx[0], y: ry[0], facing: 'd' }, { id: pfx + '2', x: cx[1], y: ry[0], facing: 'd' },
    { id: pfx + '3', x: cx[0], y: ry[1], facing: 'u' }, { id: pfx + '4', x: cx[1], y: ry[1], facing: 'u' },
  ];
}
function hubRoom() {
  const c = CATALOG.orchestration;
  return { id: 'orchestration', toolset: 'orchestration', name: c.name, tag: c.tag, tint: c.tint, color: c.color, kind: 'sync',
    x: HUB.x, y: HUB.y, w: HUB.w, h: HUB.h, waypoint: { x: HUBC.x, y: HUBC.y }, exit: { x: HUBC.x, y: HUBC.y },
    desks: [{ id: 'orc1', x: 720, y: 470, facing: 'r' }, { id: 'orc2', x: 880, y: 470, facing: 'l' }, { id: 'orc3', x: 720, y: 540, facing: 'r' }, { id: 'orc4', x: 880, y: 540, facing: 'l' }] };
}
function makeRoom(id, rect, idx) {
  const c = catalogFor(id);
  const pfx = id.slice(0, 3) + idx;
  return { id, toolset: id, name: c.name, tag: c.tag, tint: c.tint, color: c.color, generated: !!c._generated,
    x: rect.x, y: rect.y, w: rect.w, h: rect.h, exit: rect.exit, waypoint: { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }, desks: desksFor(rect, pfx) };
}

const MAX_FRAME = 14;
function buildWorld(live) {
  // resolve live toolset ids → canonical room ids (apply aliases, dedupe)
  let ids = (live && live.length ? live.slice() : DEFAULT_TOOLSETS.slice());
  ids = ids.map(s => ALIASES[s] || s);
  let frame = ids.filter(id => id !== 'orchestration');
  if (!frame.includes('gateway')) frame.push('gateway');
  frame = [...new Set(frame)];
  let overflow = [];
  if (frame.length > MAX_FRAME) { overflow = frame.slice(MAX_FRAME); frame = frame.slice(0, MAX_FRAME); }
  const counts = distribute(frame.length);
  const seqRects = [...bandRects('top', counts.top), ...bandRects('bottom', counts.bottom), ...bandRects('left', counts.left), ...bandRects('right', counts.right)];
  const rooms = [hubRoom()];
  frame.forEach((id, i) => rooms.push(makeRoom(id, seqRects[i], i)));
  return { rooms, overflow };
}

// Build the task pool + agent roster for a given room set.
function buildTasks(rooms) {
  const pool = [];
  rooms.forEach(r => (catalogFor(r.toolset).tasks || []).forEach((t, i) => pool.push({ id: `${r.id}_${i}`, room: r.id, ...t })));
  pool.push({ id: 'idle', room: 'orchestration', kind: 'idle', title: 'Standing by', bubbles: ['standing by'], log: [['idle', 'awaiting message']] });
  return pool;
}
const NAME_POOL = ['Scout', 'Echo', 'Iris', 'Nyx', 'Volt', 'Sage', 'Pixel', 'Juno', 'Wren', 'Orin', 'Lyra', 'Kit'];
function buildRoster(rooms) {
  const workRooms = rooms.filter(r => r.id !== 'orchestration' && r.id !== 'gateway');
  const roster = [{ id: 'a1', name: 'Atlas', role: 'Gateway · primary', home: 'gateway', color: CATALOG.gateway.color }];
  workRooms.forEach((r, i) => roster.push({ id: 'a' + (i + 2), name: NAME_POOL[i % NAME_POOL.length], role: r.name, home: r.id, color: r.color }));
  return roster;
}

function pathBetween(from, to, byId) {
  if (from === to) return [];
  const p = []; const f = byId[from], t = byId[to];
  if (f && f.exit && from !== 'orchestration') p.push(f.exit);
  p.push({ x: HUBC.x, y: HUBC.y });
  if (t && t.exit && to !== 'orchestration') p.push(t.exit);
  return p;
}

// ───────── HOOK ─────────
function useOfficeSim({ speed = 1, agentCount = 8, paused = false, toolsets = null } = {}) {
  const [tick, setTick] = React.useState(0);
  const stateRef = React.useRef(null);
  const pausedRef = React.useRef(paused);
  pausedRef.current = paused;
  const sig = (toolsets && toolsets.length ? toolsets.join(',') : 'demo') + '|' + agentCount;
  const sigRef = React.useRef(null);
  if (!stateRef.current || sigRef.current !== sig) { sigRef.current = sig; stateRef.current = initialState(agentCount, toolsets); }

  React.useEffect(() => {
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      if (!pausedRef.current) step(stateRef.current, dt * speed);
      setTick(t => (t + 1) % 1e6);
    }, 50);
    return () => clearInterval(id);
  }, [speed]);

  const s = stateRef.current;
  return { state: s, rooms: s.rooms, tasks: s.taskPool, overflow: s.overflow, tick };
}

function initialState(agentCount, toolsets) {
  const { rooms, overflow } = buildWorld(toolsets);
  const byId = Object.fromEntries(rooms.map(r => [r.id, r]));
  const taskPool = buildTasks(rooms);
  const tasksByRoom = taskPool.reduce((a, t) => { (a[t.room] = a[t.room] || []).push(t); return a; }, {});
  const roster = buildRoster(rooms);
  const agents = roster.slice(0, agentCount).map((a, i) => {
    const room = byId[a.home] || byId.orchestration; const desk = room.desks[i % room.desks.length];
    return { ...a, x: desk.x, y: desk.y, facing: desk.facing, mode: 'idle', path: [], target: null, task: null,
      workStartedAt: 0, workDuration: 0, progress: 0, log: [{ t: tnow(), m: 'spawned · ready' }], bubble: null, bubbleUntil: 0, idleSince: 0, lastSyncAt: 0, targetDesk: null, bubbleSchedule: [], logSchedule: [] };
  });
  return { rooms, byId, taskPool, tasksByRoom, roster, overflow, agents };
}
function tnow() { return new Date().toLocaleTimeString('en-US', { hour12: false }); }
function pickRandom(a) { return a[Math.floor(Math.random() * a.length)]; }
function pushLog(a, m) { a.log.push({ t: tnow(), m }); if (a.log.length > 60) a.log.shift(); }
function setBubble(a, text, ms = 2300) { a.bubble = text; a.bubbleUntil = performance.now() + ms; }

function chooseTask(state, agent) {
  const tbr = state.tasksByRoom; const r = Math.random();
  if (r < 0.10 && performance.now() > (agent.lastSyncAt || 0) + 30000 && tbr.orchestration) return pickRandom(tbr.orchestration);
  const home = tbr[agent.home] || [];
  if (Math.random() < 0.7 && home.length) return pickRandom(home);
  const others = Object.keys(tbr).filter(k => k !== 'orchestration');
  return others.length ? pickRandom(tbr[pickRandom(others)]) : (home[0] || tbr.orchestration[0]);
}
function currentRoomOf(state, agent) {
  for (const r of state.rooms) if (agent.x >= r.x && agent.x <= r.x + r.w && agent.y >= r.y && agent.y <= r.y + r.h) return r.id;
  return agent.home;
}
function queueTask(state, agent, task) {
  const room = state.byId[task.room]; if (!room) return;
  const desk = pickRandom(room.desks);
  const path = pathBetween(currentRoomOf(state, agent), task.room, state.byId);
  path.push({ x: room.waypoint.x, y: room.waypoint.y }); path.push({ x: desk.x, y: desk.y });
  agent.task = task; agent.targetDesk = desk; agent.path = path; agent.target = path[0]; agent.mode = 'walking'; agent.progress = 0; agent.workStartedAt = 0;
  pushLog(agent, `task → ${task.title}`);
}

function step(state, dt) {
  const now = performance.now(); const SPEED = 110;
  for (const a of state.agents) {
    if (a.bubble && now > a.bubbleUntil) a.bubble = null;
    if (a.mode === 'working' || a.mode === 'syncing') {
      if (!a.workStartedAt) {
        const dur = 10 + Math.random() * 12;
        a.workStartedAt = now; a.workDuration = dur * 1000;
        a.bubbleSchedule = (a.task?.bubbles || []).map((b, i) => ({ at: now + (i + 1) * (a.workDuration / ((a.task?.bubbles?.length || 1) + 1)), text: b }));
        a.logSchedule = (a.task?.log || []).map((row, i) => ({ at: now + (i + 1) * (a.workDuration / ((a.task?.log?.length || 1) + 1)), row }));
      }
      while (a.bubbleSchedule.length && a.bubbleSchedule[0].at <= now) setBubble(a, a.bubbleSchedule.shift().text, 2200);
      while (a.logSchedule.length && a.logSchedule[0].at <= now) pushLog(a, a.logSchedule.shift().row.join(' '));
      a.progress = Math.min(1, (now - a.workStartedAt) / a.workDuration);
      if (now - a.workStartedAt >= a.workDuration) {
        pushLog(a, '✓ done · ' + (a.task?.title || ''));
        if (a.task?.room === 'orchestration') a.lastSyncAt = now;
        a.task = null; a.workStartedAt = 0; a.workDuration = 0; a.progress = 0;
        queueTask(state, a, chooseTask(state, a));
      }
      continue;
    }
    if (a.mode === 'idle') {
      a.idleSince = a.idleSince || now;
      if (now - a.idleSince > 1000 + Math.random() * 1400) { queueTask(state, a, chooseTask(state, a)); a.idleSince = 0; }
      continue;
    }
    if (a.mode === 'walking') {
      if (!a.target) { a.mode = a.task?.room === 'orchestration' ? 'syncing' : 'working'; a.workStartedAt = 0; a.facing = a.targetDesk?.facing || 'd'; continue; }
      const dx = a.target.x - a.x, dy = a.target.y - a.y, dist = Math.hypot(dx, dy), stp = SPEED * dt;
      if (dist <= stp) { a.x = a.target.x; a.y = a.target.y; a.path.shift(); a.target = a.path[0] || null; }
      else { a.x += (dx / dist) * stp; a.y += (dy / dist) * stp; a.facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'r' : 'l') : (dy > 0 ? 'd' : 'u'); }
    }
  }
}

Object.assign(window, { useOfficeSim, OFFICE_CATALOG: CATALOG, buildWorld });
