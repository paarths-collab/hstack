// office.jsx — DOM pixel-office renderer + Visualize panel (Hermes-themed).
// Renders the world from office-sim.jsx state: rooms, furniture, monitors with
// scrolling command logs, walking agents with bubbles. Clicking an agent opens
// a live activity log. Follows the dashboard skin (cream / pixel) automatically.

const FACE_OFFSET = { u: [0, -32], d: [0, 32], l: [-36, 0], r: [36, 0] };
function deskPosFor(chair) { const o = FACE_OFFSET[chair.facing] || [0, 32]; return { x: chair.x + o[0], y: chair.y + o[1], facing: chair.facing }; }

const CODE_LINES_BY_KIND = {
  read: ['web_search', 'results 8', 'rank…', 'summary'], create: ['execute_code', 'def main()', 'exit 0', 'ok'],
  launch: ['terminal', './run.sh', '🚀 exit 0'], pause: ['guard warn', 'paused.'],
  enrich: ['memory', 'recall…', 'ok'], update: ['read_file', 'patch +3', 'saved'], import: ['POST bulk', '+1178'],
  watch: ['GET /api', 'poll 8s', 'idle…'], reply: ['send_message', 'tg send', 'ok ✓'],
  compute: ['GET kpi', 'sent 4.1k'], analytics: ['GET stats', 'hot 78'], health: ['GET /status', 'running', 'err 0.4%'],
  browse: ['browser_nav', 'snapshot', 'vision', 'ok'], media: ['vision', 'image_gen', 'tts', 'ok'],
  mcp: ['mcp call', 'server ok', '✓'], schedule: ['cronjob', '0 8 * * *', 'queued'],
  sync: ['todo', 'delegate', 'queued 3'], idle: ['idle', '·', 'awaiting…'],
};

function World({ sim, selectedId, onSelectAgent }) {
  const stageRef = React.useRef(null);
  const [scale, setScale] = React.useState(0.4);
  React.useLayoutEffect(() => {
    const el = stageRef.current; if (!el) return;
    const compute = () => { const r = el.getBoundingClientRect(); if (r.width < 10 || r.height < 10) return; setScale(Math.min(r.width / 1600, r.height / 1000) * 0.98); };
    compute();
    const ro = new ResizeObserver(compute); ro.observe(el);
    window.addEventListener('resize', compute);
    return () => { ro.disconnect(); window.removeEventListener('resize', compute); };
  }, []);
  const { agents, spawnEvents } = sim.state;
  return (
    <div className="stage-wrap" ref={stageRef}>
      <div className="stage">
        <div className="world-wrap" style={{ width: 1600 * scale, height: 1000 * scale }}>
          <div className="world" style={{ transform: `scale(${scale})` }}>
            <div className="corridor h" style={{ left: 320, top: 484, width: 960, height: 32 }} />
            <div className="corridor v" style={{ left: 784, top: 340, width: 32, height: 320 }} />
            {sim.rooms.map(r => <Room key={r.id} room={r} agents={agents} />)}
            {spawnEvents.map((e, i) => <div key={i} className="spawn-fx" style={{ left: e.x, top: e.y }} />)}
            {agents.map(a => <Agent key={a.id} agent={a} selected={a.id === selectedId} onClick={() => onSelectAgent(a.id)} />)}
          </div>
        </div>
      </div>
    </div>
  );
}

function Room({ room, agents }) {
  return (
    <div className={`room ${room.tint} room-${room.kind || 'desks'}`} style={{ left: room.x, top: room.y, width: room.w, height: room.h }}>
      <div className="room-floor" />
      <RoomDecor room={room} />
      <div className="room-label"><span className="sw" />{room.name}</div>
      <div className="room-tag">{room.tag}</div>
      {(!room.kind || room.kind === 'desks') && room.desks.map(d => {
        const occ = agents.find(a => (a.mode === 'working' || a.mode === 'syncing') && Math.abs(a.x - d.x) < 3 && Math.abs(a.y - d.y) < 3);
        return <DeskUnit key={d.id} chair={d} room={room} occupant={occ} />;
      })}
      {room.kind === 'lounge' && <LoungeFurniture room={room} />}
      {room.kind === 'sync' && <SyncFurniture room={room} agents={agents} />}
    </div>
  );
}

function RoomDecor({ room }) {
  const items = {
    web: [{ type: 'plant', x: 360, y: 30 }, { type: 'whiteboard', x: 8, y: 30, w: 50, h: 80 }],
    memory: [{ type: 'plant', x: 8, y: 30 }, { type: 'shelf', x: 320, y: 30, w: 50, h: 80 }],
    terminal: [{ type: 'screen', x: 8, y: 30, w: 90, h: 22, label: '$ ~/agent' }],
    code: [{ type: 'plant', x: 240, y: 30 }, { type: 'rug', x: 60, y: 80, w: 160, h: 120 }],
    channels: [{ type: 'plant', x: 240, y: 30 }, { type: 'shelf', x: 8, y: 30, w: 30, h: 180 }],
    mcp: [{ type: 'screen', x: 100, y: 30, w: 110, h: 28, label: 'MCP · HA' }],
    gateway: [{ type: 'screen', x: 50, y: 30, w: 80, h: 22, label: ':9119 · UP' }, { type: 'screen', x: 230, y: 30, w: 80, h: 22, label: 'CRON ·' }],
    browser: [{ type: 'screen', x: 8, y: 30, w: 100, h: 24, label: 'http ://' }, { type: 'plant', x: 290, y: 30 }],
    media: [{ type: 'screen', x: 8, y: 30, w: 90, h: 24, label: '🖼 / 🔊' }, { type: 'plant', x: 300, y: 30 }],
    orchestration: [{ type: 'screen', x: 8, y: 30, w: 80, h: 22, label: 'AGENDA' }],
  };
  return (
    <React.Fragment>
      {(items[room.id] || []).map((it, i) => {
        if (it.type === 'plant') return <div key={i} className="plant" style={{ left: it.x, top: it.y }}><div className="leaves" /><div className="pot" /></div>;
        if (it.type === 'rug') return <div key={i} className="rug" style={{ left: it.x, top: it.y, width: it.w, height: it.h }} />;
        if (it.type === 'shelf') return <div key={i} className="shelf" style={{ left: it.x, top: it.y, width: it.w, height: it.h }}><span /><span /><span /><span /></div>;
        if (it.type === 'whiteboard') return <div key={i} className="whiteboard" style={{ left: it.x, top: it.y, width: it.w, height: it.h }}><span /><span /><span /></div>;
        if (it.type === 'screen') return <div key={i} className="wallscreen" style={{ left: it.x, top: it.y, width: it.w, height: it.h }}><span>{it.label}</span></div>;
        return null;
      })}
    </React.Fragment>
  );
}

function DeskUnit({ chair, room, occupant }) {
  const cx = chair.x - room.x, cy = chair.y - room.y;
  const desk = deskPosFor(chair); const dx = desk.x - room.x, dy = desk.y - room.y;
  const horiz = chair.facing === 'u' || chair.facing === 'd';
  const w = horiz ? 72 : 44, h = horiz ? 44 : 72;
  return (
    <React.Fragment>
      <div className={`chair face-${chair.facing}`} style={{ left: cx - 11, top: cy - 11 }} />
      <div className={`desk face-${chair.facing} ${occupant ? 'occupied' : 'empty'}`} style={{ left: dx - w / 2, top: dy - h / 2, width: w, height: h, '--mon-color': occupant?.color || '#3b3b48' }}>
        <div className={`monitor mon-${chair.facing}`}>{occupant ? <MonitorContent agent={occupant} /> : <IdleMonitor />}</div>
      </div>
    </React.Fragment>
  );
}

function LoungeFurniture({ room }) {
  const px = x => x - room.x, py = y => y - room.y;
  return (
    <React.Fragment>
      <div className="coffee-table" style={{ left: px(540), top: py(170), width: 70, height: 50 }} />
      <div className="sofa h" style={{ left: px(520), top: py(120), width: 110, height: 28 }} />
      <div className="sofa h" style={{ left: px(520), top: py(232), width: 110, height: 28 }} />
      <div className="coffee-table" style={{ left: px(870), top: py(170), width: 70, height: 50 }} />
      <div className="sofa h" style={{ left: px(850), top: py(120), width: 110, height: 28 }} />
      <div className="sofa h" style={{ left: px(850), top: py(232), width: 110, height: 28 }} />
      <div className="counter" style={{ left: px(1060), top: py(60), width: 80, height: 200 }}><div className="counter-top" /><div className="counter-item" style={{ top: 12, left: 8 }}>☕</div></div>
    </React.Fragment>
  );
}
function SyncFurniture({ room }) {
  const px = x => x - room.x, py = y => y - room.y;
  return (
    <React.Fragment>
      <div className="round-table" style={{ left: px(800) - 60, top: py(505) - 40, width: 120, height: 80 }} />
      <div className="chair face-r" style={{ left: px(720) - 11, top: py(470) - 11 }} />
      <div className="chair face-l" style={{ left: px(880) - 11, top: py(470) - 11 }} />
      <div className="chair face-r" style={{ left: px(720) - 11, top: py(540) - 11 }} />
      <div className="chair face-l" style={{ left: px(880) - 11, top: py(540) - 11 }} />
    </React.Fragment>
  );
}

function MonitorContent({ agent }) {
  const lines = CODE_LINES_BY_KIND[agent.task?.kind || 'idle'] || CODE_LINES_BY_KIND.idle;
  const visible = Math.max(2, Math.min(lines.length, Math.floor(agent.progress * lines.length) + 2));
  const shown = lines.slice(0, visible);
  return (
    <React.Fragment>
      <div className="mon-text">{shown.map((l, i) => <div key={i} className={`mon-line ${i === shown.length - 1 ? 'fresh' : ''}`}><span className="mon-prompt">›</span>{l}</div>)}</div>
      <div className="progress"><div className="bar" style={{ width: `${Math.round(agent.progress * 100)}%` }} /></div>
    </React.Fragment>
  );
}
function IdleMonitor() {
  return <React.Fragment><div className="mon-text mon-idle"><div className="mon-line"><span className="mon-prompt">›</span>idle</div></div><div className="progress" style={{ opacity: .25 }}><div className="bar" style={{ width: '0%' }} /></div></React.Fragment>;
}

function Agent({ agent, selected, onClick }) {
  const initials = agent.name.slice(0, 2);
  return (
    <div className={`agent mode-${agent.mode} ${selected ? 'selected' : ''} ${agent.mode === 'walking' ? 'bob' : ''}`} data-facing={agent.facing}
      style={{ left: agent.x, top: agent.y, '--agent-color': agent.color }} onClick={onClick}>
      <div className="status-ring" /><div className="agent-shadow" />
      <div className="agent-body"><div className="head" /><div className="torso"><span className="initials">{initials}</span></div></div>
      {agent.bubble && <div className="bubble" title={agent.bubble}>{agent.bubble}</div>}
    </div>
  );
}

function colorizeLog(m) {
  return m.replace(/^(GET|POST|PUT|PATCH|DELETE)\s+/, '<span class="tag">$1</span> ')
    .replace(/(^|\s)(ok|✓[^<]*)/, '$1<span class="ok">$2</span>')
    .replace(/(^|\s)(err|warn)\b/, '$1<span class="err">$2</span>');
}

// ---------- VISUALIZE PANEL ----------
function Visualize({ data, caps, agentCount = 8 }) {
  const [paused, setPaused] = React.useState(false);
  const [sel, setSel] = React.useState(null);
  const sim = useOfficeSim({ agentCount, paused, toolsets: caps && caps.toolsets });
  const agents = sim.state.agents;
  const selAgent = agents.find(a => a.id === sel) || null;
  // Live toolsets drive the grid — a new tool the agent gains shows up here automatically.
  const liveTools = (caps && caps.toolsets && caps.toolsets.length) ? caps.toolsets : window.HData.DEMO.capabilitiesProbe.toolsets;

  // global recent feed across agents
  const feed = [];
  agents.forEach(a => a.log.slice(-4).forEach(e => feed.push({ ...e, name: a.name, color: a.color })));
  feed.sort((x, y) => (x.t < y.t ? 1 : -1));
  const recent = feed.slice(0, 16);

  const MODE_LABEL = { working: 'Working', walking: 'Moving', syncing: 'Planning', idle: 'Idle', spawning: 'Spawning' };
  const MODE_COLOR = { working: 'var(--ok)', walking: 'var(--warn)', syncing: 'var(--accent)', idle: 'var(--ink-faint)', spawning: 'var(--accent)' };

  return (
    <div>
      <SectionHead title="Visualize" sub="A live office for your agent. Atlas and its sub-agents walk between toolsets — watch which tool each is running and what it's working on, in real time." />
      <div className="viz">
        <div className="viz-stage">
          <World sim={sim} selectedId={sel} onSelectAgent={(id) => setSel(s => s === id ? null : id)} />
          <div className="viz-toolbar">
            <button className="vt" onClick={() => setPaused(p => !p)}>{paused ? '▶ Play' : '⏸ Pause'}</button>
            <span className="vt" style={{ cursor: 'default' }}>{data.live ? '● LIVE' : '● DEMO'}</span>
            <span className="vt" style={{ cursor: 'default' }}>{agents.length} agents</span>
          </div>
          <div className="viz-legend">
            {[['working', 'Working'], ['walking', 'Moving'], ['syncing', 'Planning'], ['idle', 'Idle']].map(([k, l]) => (
              <span key={k} className="l"><span className="dotmark" style={{ background: MODE_COLOR[k] }} />{l}</span>
            ))}
          </div>
        </div>

        <div className="viz-side">
          {selAgent ? (
            <Card span={12} style={{ '--ag': selAgent.color }}>
              <div className="between">
                <div className="row" style={{ gap: 11 }}>
                  <span className="agent-av" style={{ background: selAgent.color }}>{selAgent.name.slice(0, 2)}</span>
                  <div><div className="an" style={{ fontWeight: 800, fontSize: 15 }}>{selAgent.name}</div><div className="as">{selAgent.role}</div></div>
                </div>
                <button className="chip x" onClick={() => setSel(null)}>✕</button>
              </div>
              <div className="between" style={{ marginTop: 14 }}>
                <span className="k">Now</span><span style={{ fontSize: 13, fontWeight: 600, textAlign: 'right', maxWidth: 180 }}>{selAgent.task ? selAgent.task.title : selAgent.mode === 'walking' ? 'Walking to next desk' : 'Idle · awaiting orders'}</span>
              </div>
              <div className="between" style={{ marginTop: 8 }}>
                <span className="k">Status</span><span className="delta" style={{ background: 'var(--card-2)', color: MODE_COLOR[selAgent.mode] }}>{MODE_LABEL[selAgent.mode]}{selAgent.task ? ` · ${Math.round(selAgent.progress * 100)}%` : ''}</span>
              </div>
              <div className="k" style={{ marginTop: 14 }}>Activity log</div>
              <div className="feed" style={{ maxHeight: 240 }}>
                {selAgent.log.slice(-16).reverse().map((e, i) => (
                  <div key={i} className="fe"><span className="ft">{e.t.slice(0, 5)}</span><span className="fi" style={{ background: selAgent.color }} /><div className="logm" dangerouslySetInnerHTML={{ __html: colorizeLog(e.m) }} /></div>
                ))}
              </div>
            </Card>
          ) : (
            <Card span={12}>
              <K>Agents ({agents.length})</K>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 12 }}>
                {agents.map(a => (
                  <div key={a.id} className="agent-row" onClick={() => setSel(a.id)}>
                    <span className="agent-av sm" style={{ background: a.color }}>{a.name.slice(0, 2)}</span>
                    <div style={{ minWidth: 0 }}><div className="an">{a.name}</div><div className="as">{a.task ? a.task.title.slice(0, 22) : MODE_LABEL[a.mode]}</div></div>
                    <span className="state-dot" style={{ background: MODE_COLOR[a.mode] }} />
                  </div>
                ))}
              </div>
            </Card>
          )}

          <Card span={12}>
            <K>Tool & command feed</K>
            <div className="feed">
              {recent.map((f, i) => (
                <div key={i} className="fe"><span className="ft">{f.t.slice(0, 5)}</span><span className="fi" style={{ background: f.color }} /><div><b>{f.name}</b> <span className="logm" dangerouslySetInnerHTML={{ __html: colorizeLog(f.m) }} /></div></div>
              ))}
            </div>
          </Card>

          <Card span={12}>
            <K>Active toolsets ({liveTools.length})</K>
            <div className="toolgrid">
              {liveTools.map(id => {
                const m = window.HData.toolMeta(id);
                return <div key={id} className={'tl' + (m.known ? '' : ' tl-new')} title={m.known ? '' : 'New tool — auto-detected'}><span className="ti"><Icon name={m.glyph} size={14} /></span>{m.label}{m.known ? '' : ' ＋'}</div>;
              })}
            </div>
            {sim.overflow && sim.overflow.length ? <div className="sub" style={{ marginTop: 10, fontSize: 12 }}>+{sim.overflow.length} more tool{sim.overflow.length > 1 ? 's' : ''} (room cap reached)</div> : null}
          </Card>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { Visualize, OfficeWorld: World });
