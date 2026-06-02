"use client";
import * as React from "react";
import { useOfficeSim } from "./sim";
import { toolMeta, type Bundle } from "@/lib/hermes";
import { Card } from "@/components/ui/card";

/* eslint-disable @typescript-eslint/no-explicit-any */
const FACE_OFFSET: Record<string, [number, number]> = { u: [0, -32], d: [0, 32], l: [-36, 0], r: [36, 0] };
const CODE_LINES: Record<string, string[]> = {
  read: ["web_search", "results 8", "rank…", "summary"], create: ["execute_code", "def main()", "exit 0", "ok"],
  launch: ["terminal", "./run.sh", "🚀 exit 0"], enrich: ["memory", "recall…", "ok"], update: ["read_file", "patch +3", "saved"],
  watch: ["GET /api", "poll 8s", "idle…"], reply: ["send_message", "tg send", "ok ✓"], compute: ["GET kpi", "sent"],
  browse: ["browser_nav", "snapshot", "vision", "ok"], media: ["vision", "image_gen", "tts", "ok"],
  mcp: ["mcp call", "server ok", "✓"], schedule: ["cronjob", "0 8 * * *", "queued"],
  health: ["GET /status", "running", "err 0.4%"], sync: ["todo", "delegate", "queued 3"], idle: ["idle", "·", "awaiting…"],
};
const MODE_LABEL: Record<string, string> = { working: "Working", walking: "Moving", syncing: "Planning", idle: "Idle" };
const MODE_COLOR: Record<string, string> = { working: "var(--ok)", walking: "var(--warn)", syncing: "#2a6fdb", idle: "var(--ink-faint)" };

function colorize(m: string) {
  return m.replace(/^(GET|POST|PUT|PATCH|DELETE)\s+/, '<span class="tag">$1</span> ')
    .replace(/(^|\s)(ok|✓[^<]*)/, '$1<span class="ok">$2</span>')
    .replace(/(^|\s)(err|warn)\b/, '$1<span class="err">$2</span>');
}

function World({ sim, sel, onSelect }: { sim: any; sel: string | null; onSelect: (id: string) => void }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [scale, setScale] = React.useState(0.4);
  React.useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const compute = () => { const r = el.getBoundingClientRect(); if (r.width < 10) return; setScale(Math.min(r.width / 1600, r.height / 1000) * 0.98); };
    compute(); const ro = new ResizeObserver(compute); ro.observe(el); return () => ro.disconnect();
  }, []);
  const agents = sim.state.agents;
  return (
    <div className="stage-wrap" ref={ref}>
      <div className="stage">
        <div className="world-wrap" style={{ width: 1600 * scale, height: 1000 * scale }}>
          <div className="world" style={{ transform: `scale(${scale})` }}>
            <div className="corridor" style={{ left: 320, top: 484, width: 960, height: 32 }} />
            <div className="corridor" style={{ left: 784, top: 340, width: 32, height: 320 }} />
            {sim.rooms.map((r: any) => <Room key={r.id} room={r} agents={agents} />)}
            {agents.map((a: any) => <Agent key={a.id} agent={a} selected={a.id === sel} onClick={() => onSelect(a.id)} />)}
          </div>
        </div>
      </div>
    </div>
  );
}
function Room({ room, agents }: { room: any; agents: any[] }) {
  return (
    <div className={`room ${room.tint} room-${room.kind || "desks"}`} style={{ left: room.x, top: room.y, width: room.w, height: room.h }}>
      <div className="room-floor" />
      <div className="room-label"><span className="sw" />{room.name}</div>
      <div className="room-tag">{room.tag}</div>
      {(!room.kind || room.kind === "desks") && room.desks.map((d: any) => {
        const occ = agents.find((a) => (a.mode === "working" || a.mode === "syncing") && Math.abs(a.x - d.x) < 3 && Math.abs(a.y - d.y) < 3);
        return <DeskUnit key={d.id} chair={d} room={room} occupant={occ} />;
      })}
      {room.kind === "lounge" && <Lounge room={room} />}
      {room.kind === "sync" && <Sync room={room} />}
    </div>
  );
}
function DeskUnit({ chair, room, occupant }: any) {
  const cx = chair.x - room.x, cy = chair.y - room.y;
  const off = FACE_OFFSET[chair.facing] || [0, 32];
  const dx = chair.x + off[0] - room.x, dy = chair.y + off[1] - room.y;
  const horiz = chair.facing === "u" || chair.facing === "d";
  const w = horiz ? 72 : 44, h = horiz ? 44 : 72;
  return (
    <>
      <div className={`chair face-${chair.facing}`} style={{ left: cx - 11, top: cy - 11 }} />
      <div className="desk" style={{ left: dx - w / 2, top: dy - h / 2, width: w, height: h, ["--mon-color" as any]: occupant?.color || "#3b3b48" }}>
        <div className={`monitor mon-${chair.facing}`}>{occupant ? <Monitor agent={occupant} /> : <Idle />}</div>
      </div>
    </>
  );
}
function Monitor({ agent }: { agent: any }) {
  const lines = CODE_LINES[agent.task?.kind || "idle"] || CODE_LINES.idle;
  const vis = Math.max(2, Math.min(lines.length, Math.floor(agent.progress * lines.length) + 2));
  return (<>
    <div className="mon-text">{lines.slice(0, vis).map((l, i) => <div key={i} className={`mon-line ${i === vis - 1 ? "fresh" : ""}`}><span className="mon-prompt">›</span>{l}</div>)}</div>
    <div className="progress"><div className="bar" style={{ width: `${Math.round(agent.progress * 100)}%` }} /></div>
  </>);
}
function Idle() { return (<><div className="mon-text mon-idle"><div className="mon-line"><span className="mon-prompt">›</span>idle</div></div><div className="progress" style={{ opacity: .25 }}><div className="bar" style={{ width: "0%" }} /></div></>); }
function Lounge({ room }: any) {
  const px = (x: number) => x - room.x, py = (y: number) => y - room.y;
  return (<>
    <div className="coffee-table" style={{ left: px(540), top: py(170), width: 70, height: 50 }} />
    <div className="sofa h" style={{ left: px(520), top: py(120), width: 110, height: 28 }} />
    <div className="sofa h" style={{ left: px(520), top: py(232), width: 110, height: 28 }} />
    <div className="coffee-table" style={{ left: px(870), top: py(170), width: 70, height: 50 }} />
    <div className="sofa h" style={{ left: px(850), top: py(120), width: 110, height: 28 }} />
    <div className="counter" style={{ left: px(1060), top: py(60), width: 80, height: 200 }}><div className="counter-top" /><div className="counter-item" style={{ top: 12, left: 8 }}>☕</div></div>
  </>);
}
function Sync({ room }: any) {
  const px = (x: number) => x - room.x, py = (y: number) => y - room.y;
  return (<>
    <div className="round-table" style={{ left: px(800) - 60, top: py(505) - 40, width: 120, height: 80 }} />
    <div className="chair face-r" style={{ left: px(720) - 11, top: py(470) - 11 }} />
    <div className="chair face-l" style={{ left: px(880) - 11, top: py(470) - 11 }} />
    <div className="chair face-r" style={{ left: px(720) - 11, top: py(540) - 11 }} />
    <div className="chair face-l" style={{ left: px(880) - 11, top: py(540) - 11 }} />
  </>);
}
function Agent({ agent, selected, onClick }: any) {
  return (
    <div className={`agent mode-${agent.mode} ${selected ? "selected" : ""} ${agent.mode === "walking" ? "bob" : ""}`} data-facing={agent.facing}
      style={{ left: agent.x, top: agent.y, ["--agent-color" as any]: agent.color }} onClick={onClick}>
      <div className="status-ring" /><div className="agent-shadow" />
      <div className="agent-body"><div className="head" /><div className="torso"><span className="initials">{agent.name.slice(0, 2)}</span></div></div>
      {agent.bubble && <div className="bubble">{agent.bubble}</div>}
    </div>
  );
}

export function Visualize({ data, caps, agentCount = 8 }: { data: Bundle; caps: { toolsets: string[] }; agentCount?: number }) {
  const [paused, setPaused] = React.useState(false);
  const [sel, setSel] = React.useState<string | null>(null);
  const live = caps && caps.toolsets && caps.toolsets.length ? caps.toolsets : ["web", "browser", "media", "memory", "terminal", "channels", "code", "mcp", "cron", "orchestration"];
  const sim = useOfficeSim({ agentCount, paused, toolsets: live });
  const agents = sim.state.agents;
  const selAgent = agents.find((a: any) => a.id === sel) || null;
  const feed: any[] = [];
  agents.forEach((a: any) => a.log.slice(-4).forEach((e: any) => feed.push({ ...e, name: a.name, color: a.color })));
  feed.sort((x, y) => (x.t < y.t ? 1 : -1));

  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <h2 style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-.03em" }}>Visualize</h2>
        <p style={{ color: "var(--ink-soft)", marginTop: 4 }}>A live office for your agent. Atlas and its sub-agents walk between toolsets — watch which tool each is running and what it&apos;s working on.</p>
      </div>
      <div className="viz">
        <div className="viz-stage">
          <World sim={sim} sel={sel} onSelect={(id) => setSel((s) => (s === id ? null : id))} />
          <div className="viz-toolbar">
            <button className="vt" onClick={() => setPaused((p) => !p)}>{paused ? "▶ Play" : "⏸ Pause"}</button>
            <span className="vt">{data.live ? "● LIVE" : "● DEMO"}</span>
            <span className="vt">{agents.length} agents</span>
          </div>
          <div className="viz-legend">
            {Object.entries(MODE_LABEL).map(([k, l]) => <span key={k} className="l"><span className="dotmark" style={{ background: MODE_COLOR[k] }} />{l}</span>)}
          </div>
        </div>
        <div className="viz-side">
          {selAgent ? (
            <Card className="p-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3"><span className="agent-av" style={{ background: selAgent.color }}>{selAgent.name.slice(0, 2)}</span>
                  <div><div className="an" style={{ fontWeight: 800, fontSize: 15 }}>{selAgent.name}</div><div className="as">{selAgent.role}</div></div></div>
                <button className="chip" onClick={() => setSel(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--ink-soft)" }}>✕</button>
              </div>
              <div style={{ marginTop: 14 }} className="text-[13px]"><b>Now:</b> {selAgent.task ? selAgent.task.title : selAgent.mode === "walking" ? "Walking to next desk" : "Idle"}</div>
              <div className="feed" style={{ maxHeight: 240, marginTop: 10 }}>
                {selAgent.log.slice(-16).reverse().map((e: any, i: number) => (
                  <div key={i} className="fe"><span className="ft">{e.t.slice(0, 5)}</span><span className="fi" style={{ background: selAgent.color }} /><div className="logm" dangerouslySetInnerHTML={{ __html: colorize(e.m) }} /></div>
                ))}
              </div>
            </Card>
          ) : (
            <Card className="p-5">
              <div className="num" style={{ fontSize: 10.5, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--ink-soft)", fontWeight: 700 }}>Agents ({agents.length})</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 12 }}>
                {agents.map((a: any) => (
                  <div key={a.id} className="agent-row" onClick={() => setSel(a.id)}>
                    <span className="agent-av sm" style={{ background: a.color }}>{a.name.slice(0, 2)}</span>
                    <div style={{ minWidth: 0 }}><div className="an">{a.name}</div><div className="as">{a.task ? a.task.title.slice(0, 22) : MODE_LABEL[a.mode]}</div></div>
                    <span className="state-dot" style={{ background: MODE_COLOR[a.mode] }} />
                  </div>
                ))}
              </div>
            </Card>
          )}
          <Card className="p-5">
            <div className="num" style={{ fontSize: 10.5, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--ink-soft)", fontWeight: 700 }}>Tool &amp; command feed</div>
            <div className="feed">
              {feed.slice(0, 16).map((f, i) => (
                <div key={i} className="fe"><span className="ft">{f.t.slice(0, 5)}</span><span className="fi" style={{ background: f.color }} /><div><b>{f.name}</b> <span className="logm" dangerouslySetInnerHTML={{ __html: colorize(f.m) }} /></div></div>
              ))}
            </div>
          </Card>
          <Card className="p-5">
            <div className="num" style={{ fontSize: 10.5, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--ink-soft)", fontWeight: 700 }}>Active toolsets ({live.length})</div>
            <div className="toolgrid">
              {live.map((id) => { const m = toolMeta(id); return <div key={id} className={"tl" + (m.known ? "" : " tl-new")} title={m.known ? "" : "New tool — auto-detected"}><span className="ti">▣</span>{m.label}{m.known ? "" : " ＋"}</div>; })}
            </div>
            {sim.overflow && sim.overflow.length ? <div className="sub" style={{ marginTop: 10, fontSize: 12 }}>+{sim.overflow.length} more tool{sim.overflow.length > 1 ? "s" : ""} (room cap reached)</div> : null}
          </Card>
        </div>
      </div>
    </div>
  );
}
