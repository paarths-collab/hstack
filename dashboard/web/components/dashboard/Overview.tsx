"use client";
import * as React from "react";
import type { Bundle } from "@/lib/hermes";
import { TOOLS } from "@/lib/hermes";
import { K, BentoCard, Meter, AreaChart, Ring, Rings, Bars, Wave, fmt, PLAT_COLOR, StatePill } from "./charts";

const GLYPH_MAP: Record<string, string> = {
  web: "search", browser: "radio", terminal: "terminal", code: "code",
  memory: "database", channels: "mail", media: "eye", cron: "cal",
  orchestration: "share", mcp: "cpu",
};

function toolGlyph(id: string) { return GLYPH_MAP[id] || "grid"; }

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const ICONS: Record<string, string> = {
    search: "M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3",
    radio: "M4.9 19.1a10 10 0 010-14.2M19.1 4.9a10 10 0 010 14.2M7.8 16.2a6 6 0 010-8.5M16.2 7.8a6 6 0 010 8.5M12 13a1 1 0 100-2 1 1 0 000 2z",
    terminal: "M4 5h16v14H4zM7 9l3 3-3 3M13 15h4",
    database: "M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3zM4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
    mail: "M3 6h18v12H3zM3 7l9 6 9-6",
    eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z",
    code: "M9 18l-6-6 6-6M15 6l6 6-6 6",
    cal: "M3 6a2 2 0 012-2h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2zM3 10h18M8 2v4M16 2v4",
    share: "M18 8a3 3 0 10-2.8-4M6 15a3 3 0 100-6 3 3 0 000 6zM18 22a3 3 0 10-2.8-4M8.6 13.5l6.8 4M15.4 6.5l-6.8 4",
    cpu: "M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3M6 6h12v12H6zM10 10h4v4h-4z",
    grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
    bolt: "M13 2L4 14h7l-1 8 9-12h-7l1-8z",
    lock: "M6 11h12v9H6zM8 11V8a4 4 0 018 0v3",
    arrow: "M5 12h14M13 6l6 6-6 6",
    coins: "M9 14a6 6 0 100-12 6 6 0 000 12zM15 22a6 6 0 100-12M9 8h.01",
    clock: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2",
    game: "M6 12h4M8 10v4M15 11h.01M18 13h.01M7 7h10a4 4 0 014 4v2a4 4 0 01-4 4c-1.5 0-2-1-3-2H10c-1 1-1.5 2-3 2a4 4 0 01-4-4v-2a4 4 0 014-4z",
  };
  const d = ICONS[name] || ICONS.grid;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      {d.split("M").filter(Boolean).map((seg, i) => <path key={i} d={"M" + seg} />)}
    </svg>
  );
}

export function Overview({ data, caps, onVisualize, onNav }: {
  data: Bundle; caps: { toolsets: string[] }; onVisualize: () => void; onNav: (p: string) => void;
}) {
  const s = data.status;
  const online = (s.gateway as { running?: boolean })?.running ?? true;
  const plats = s.platforms || [];
  const u = data.usage.totals || {};
  const h = s.health || {};
  const mem = s.memory || {};
  const cap = s.capabilities || {};
  const upSec = s.uptime_seconds || 0;
  const upDays = Math.floor(upSec / 86400);
  const upHrs = Math.floor((upSec % 86400) / 3600);
  const upMin = Math.floor((upSec % 3600) / 60);
  const d = new Date();

  const capMap: Record<string, [string, string, string]> = {
    ok: ["OK", "var(--ok)", "var(--ok-soft)"],
    degraded: ["No key", "var(--accent-deep)", "var(--accent-soft)"],
    off: ["Off", "var(--ink-soft)", "var(--line-soft)"],
  };

  const tokPerMsg = u.tokens && u.messages ? (u.tokens / u.messages / 1000).toFixed(1) : "8.7";

  return (
    <div>
      {/* ── hero ── */}
      <div className="hero">
        <div className="datechip">
          <div className="daynum num">{d.getDate()}</div>
          <div className="dl">
            {d.toLocaleDateString([], { weekday: "short" })},
            <small>{d.toLocaleDateString([], { month: "long" })}</small>
          </div>
          <div style={{ width: 1, height: 38, background: "var(--line)", margin: "0 4px" }} />
          <button className="btn-primary" onClick={onVisualize}>
            <Icon name="game" size={18} /> Visualize
          </button>
          <div className="icon-btn" style={{ width: 50, height: 50 }} title="Activity" onClick={() => onNav("ledger")}>
            <Icon name="cal" size={18} />
          </div>
        </div>
        <div className="ask">
          <h1>
            Your agent is <span className="em">{online ? "working" : "offline"}.</span><br />
            <span className="g">Watch it live, anytime.</span>
          </h1>
        </div>
      </div>

      <div className="bento">
        {/* row 1 */}
        <BentoCard span={5} delay={0.02} className=" lite">
          <div className="between">
            <div className="row" style={{ gap: 9, fontWeight: 800, fontSize: 15 }}>
              <Icon name="bolt" size={18} /> Hermes Gateway
            </div>
            <span className="chip x">Read-only ▾</span>
          </div>
          <div className="sub" style={{ marginTop: 18 }}>Bound to a private address</div>
          <div className="num" style={{ fontSize: 22, fontWeight: 800, marginTop: 4, letterSpacing: "-.01em" }}>
            127.0.0.1 : 9119
          </div>
          <div className="row" style={{ gap: 10, marginTop: 16 }}>
            <span className="chip" style={{ background: "var(--ink-dark)", color: "#fff", border: "none" }}>
              <span className="dotmark bp" style={{ background: online ? "var(--ok)" : "var(--accent)" }} />
              {online ? "Online" : "Offline"}
            </span>
            <span className="chip">v{s.version || "—"}</span>
            <span className="chip">{upDays}d uptime</span>
          </div>
          <div style={{ flex: 1 }} />
          <div className="between" style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
            <div>
              <div className="sub" style={{ marginTop: 0 }}>Poll cadence</div>
              <div className="num" style={{ fontWeight: 800, fontSize: 18 }}>10s</div>
            </div>
            <button className="chip x" onClick={() => onNav("about")} style={{ color: "var(--accent-deep)" }}>
              <Icon name="lock" size={14} /> Security model
            </button>
          </div>
        </BentoCard>

        <BentoCard span={4} delay={0.06}>
          <div className="between">
            <div className="row" style={{ gap: 9 }}>
              <span className="icon-btn" style={{ width: 36, height: 36 }}><Icon name="arrow" size={15} /></span>
              <span className="sub" style={{ marginTop: 0, fontWeight: 700, color: "var(--ink)" }}>Messages · 7d</span>
            </div>
            <span className="chip x">Weekly ▾</span>
          </div>
          <div className="big num">{fmt(u.messages ?? 0)}</div>
          <div style={{ height: 1, background: "var(--line)", margin: "16px 0" }} />
          <div className="between">
            <div className="row" style={{ gap: 9 }}>
              <span className="icon-btn" style={{ width: 36, height: 36 }}><Icon name="coins" size={15} /></span>
              <span className="sub" style={{ marginTop: 0, fontWeight: 700, color: "var(--ink)" }}>Tokens · 7d</span>
            </div>
            <button className="chip x" onClick={() => onNav("usage")} style={{ color: "var(--accent-deep)" }}>chart ↗</button>
          </div>
          <div className="big num">{fmt(u.tokens ?? 0)}</div>
        </BentoCard>

        <BentoCard span={3} delay={0.1} className=" dark" style={{ alignItems: "center", justifyContent: "center" }}>
          <K>Cache hit rate</K>
          <div style={{ marginTop: 8 }}>
            <Ring pct={u.cache_hit_rate ?? 71} label={(u.cache_hit_rate ?? 71) + "%"} sub="cheaper turns" color="var(--accent)" />
          </div>
        </BentoCard>

        {/* row 2 */}
        <BentoCard span={5} delay={0.14}>
          <K>Server health</K>
          <div style={{ marginTop: 14 }}>
            <Meter label="CPU" pct={h.cpu ?? 24} />
            <Meter label="Memory" pct={h.mem ?? 61} />
            <Meter label="Disk" pct={h.disk ?? 43} />
          </div>
        </BentoCard>

        <BentoCard span={4} delay={0.18}>
          <K>Agent memory <span className="muted" style={{ textTransform: "none", letterSpacing: 0, fontFamily: "var(--font-sans)" }}>— fills fast</span></K>
          <div style={{ marginTop: 14 }}>
            <Meter
              label="User profile"
              pct={Math.round(((mem.user ?? 0) / (mem.user_max ?? 1)) * 100)}
              value={mem.user ? `${mem.user}/${mem.user_max}` : undefined}
            />
            <Meter
              label="Agent memory"
              pct={Math.round(((mem.agent ?? 0) / (mem.agent_max ?? 1)) * 100)}
              value={mem.agent ? `${mem.agent}/${mem.agent_max}` : undefined}
            />
          </div>
          <div className="sub">Near full → wasted turns. Add a memory provider with <code className="mono" style={{ color: "var(--accent-deep)", fontSize: 11 }}>/hermes-memory</code>.</div>
        </BentoCard>

        <BentoCard span={3} delay={0.22}>
          <K>Capability health</K>
          <div style={{ display: "flex", flexDirection: "column", gap: 9, marginTop: 13 }}>
            {Object.entries(cap).map(([n, st]) => {
              const [t, c, bg] = capMap[st as string] || capMap.ok;
              return (
                <div key={n} className="between">
                  <span style={{ fontWeight: 700, fontSize: 13, whiteSpace: "nowrap" }}>{n}</span>
                  <span className="delta" style={{ background: bg, color: c }}>{t}</span>
                </div>
              );
            })}
          </div>
        </BentoCard>

        {/* row 3 */}
        <BentoCard span={5} delay={0.24}>
          <div className="between"><K>Activity — last 7 days</K><span className="delta">▲ +12%</span></div>
          <AreaChart data={data.usage.daily?.map((d) => d.messages) || [0]} color="var(--accent)" height={140} />
        </BentoCard>

        <BentoCard span={4} delay={0.28}>
          <div className="between"><K>Volume by channel</K><span className="chip x">7d ▾</span></div>
          <Rings items={[
            { label: fmt(186), v: 186, c: "#FBE3DB" },
            { label: fmt(120), v: 120, c: "#F6C9BC" },
            { label: fmt(64), v: 64, c: "#EE9A82" },
            { label: fmt(28), v: 28, c: "var(--accent)", ink: "#fff" },
          ]} />
        </BentoCard>

        <BentoCard span={3} delay={0.32}>
          <div className="row" style={{ gap: 9 }}>
            <span className="icon-btn" style={{ width: 34, height: 34 }}><Icon name="clock" size={15} /></span>
          </div>
          <div className="big num" style={{ marginTop: 14 }}>{upDays} Days</div>
          <div className="sub">{upDays * 24 + upHrs}h {upMin}m uptime</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(13,1fr)", gap: 5, marginTop: 14 }}>
            {Array.from({ length: 26 }, (_, i) => (
              <span key={i} style={{
                width: "100%", aspectRatio: "1/1", borderRadius: "50%",
                background: i < upDays * 2 ? "var(--accent)" : "var(--line)",
              }} />
            ))}
          </div>
        </BentoCard>

        {/* row 4 */}
        <BentoCard span={5} delay={0.34}>
          <div className="between">
            <K>Live throughput</K>
            <div className="row" style={{ gap: 6 }}>
              <span className="chip x">Filters</span>
            </div>
          </div>
          <div className="row" style={{ gap: 8, marginTop: 14 }}>
            <span className="big num" style={{ fontSize: 34 }}>{tokPerMsg}k</span>
            <span className="sub" style={{ marginTop: 12 }}>tokens / message avg</span>
          </div>
          <Wave n={22} hotAt={13} />
        </BentoCard>

        <BentoCard span={4} delay={0.38}>
          <div className="between"><K>Active toolsets</K><span className="chip x">⋮</span></div>
          <div style={{ display: "flex", flexDirection: "column", gap: 0, marginTop: 6 }}>
            {(caps.toolsets || []).slice(0, 4).map((t, i) => {
              const tool = TOOLS.find((x) => x.id === t);
              return (
                <div key={t} className="between" style={{ padding: "11px 0", borderTop: i ? "1px solid var(--line)" : "none" }}>
                  <span className="row" style={{ gap: 10, fontWeight: 700, fontSize: 13.5 }}>
                    <span style={{
                      width: 26, height: 26, borderRadius: "50%", background: "var(--accent)", color: "#fff",
                      display: "grid", placeItems: "center",
                    }}>
                      <Icon name={tool ? tool.glyph : toolGlyph(t)} size={13} />
                    </span>
                    {tool ? tool.label : t}
                  </span>
                  <span className="chip x" style={{ fontSize: 11 }}>▾</span>
                </div>
              );
            })}
          </div>
        </BentoCard>

        <BentoCard span={3} delay={0.42} className=" lite">
          <div className="between"><K>Overall</K></div>
          <div className="sub" style={{ marginTop: 14 }}>How is your agent doing?</div>
          <div style={{ fontWeight: 800, fontSize: 19, letterSpacing: "-.02em", marginTop: 4, lineHeight: 1.2 }}>
            {online ? "Healthy & responsive" : "Needs attention"}
          </div>
          <div className="row" style={{ gap: 8, marginTop: 16 }}>
            {["😟", "🙁", "😐", "🙂", "😄"].map((e, i) => (
              <span key={i} className="icon-btn" style={{
                width: 40, height: 40, fontSize: 17,
                opacity: i === (online ? 4 : 1) ? 1 : 0.4,
                borderColor: i === (online ? 4 : 1) ? "var(--accent)" : "var(--line)",
              }}>{e}</span>
            ))}
          </div>
        </BentoCard>

        {/* row 5 — full-width ledger */}
        <BentoCard span={12} delay={0.46} className=" ledger">
          <div className="hd">
            <h3>Recent activity</h3>
            <button className="chip x" onClick={() => onNav("ledger")}>View full ledger ↗</button>
          </div>
          <table>
            <thead>
              <tr><th>When</th><th>Channel</th><th>What happened</th><th>Tool</th><th className="t-right">Tokens</th></tr>
            </thead>
            <tbody>
              {data.sessions.slice(0, 6).map((row) => (
                <tr key={row.id}>
                  <td className="muted num" style={{ fontSize: 12.5 }}>{(row.updated || "").slice(11, 16) || "—"}</td>
                  <td><span className="chan"><span className="dotmark" style={{ background: PLAT_COLOR[row.platform || ""] || "var(--accent)" }} />{row.platform || "agent"}</span></td>
                  <td>{row.summary || "activity"}</td>
                  <td><code className="mono" style={{ fontSize: 11.5, background: "var(--card-2)", padding: "2px 6px", borderRadius: 6 }}>{row.tool || "—"}</code></td>
                  <td className="t-right num">{fmt(row.tokens || 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </BentoCard>
      </div>
    </div>
  );
}
