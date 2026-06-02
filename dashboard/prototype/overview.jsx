/* overview.jsx — the Overview bento (mirrors the reference image composition) */

function Hero({ data, onVisualize }) {
  const online = data.status.gateway?.running ?? true;
  const d = new Date();
  const day = d.getDate();
  const wd = d.toLocaleDateString([], { weekday: "short" });
  const mo = d.toLocaleDateString([], { month: "long" });
  return (
    <div className="hero">
      <div className="datechip">
        <div className="daynum num">{day}</div>
        <div className="dl">{wd},<small>{mo}</small></div>
        <div style={{ width: 1, height: 38, background: "var(--line)", margin: "0 4px" }} />
        <button className="btn-primary" onClick={onVisualize}>
          <Icon name="game" size={18} /> Visualize
        </button>
        <div className="icon-btn" title="Activity"><Icon name="cal" size={18} /></div>
      </div>
      <div className="ask">
        <h1>
          Your agent is <span className="em">{online ? "working" : "offline"}.</span><br />
          <span className="g">Watch it live, anytime.</span>
        </h1>
      </div>
    </div>
  );
}

function Overview({ data, caps, onVisualize, onNav }) {
  const s = data.status;
  const online = s.gateway?.running ?? true;
  const plats = s.platforms || [];
  const live = plats.filter((p) => p.connected).length;
  const u = data.usage.totals || {};
  const jobs = data.cron || [];
  const h = s.health || {};
  const mem = s.memory || {};
  const cap = s.capabilities || {};
  const upDays = Math.floor((s.uptime_seconds || 0) / 86400);
  const upHrs = Math.floor(((s.uptime_seconds || 0) % 86400) / 3600);
  const upMin = Math.floor(((s.uptime_seconds || 0) % 3600) / 60);

  const capMap = {
    ok: ["OK", "var(--ok)", "var(--ok-soft)"],
    degraded: ["No key", "var(--accent-deep)", "var(--accent-soft)"],
    off: ["Off", "var(--ink-soft)", "var(--line-soft)"],
  };

  return (
    <div>
      <Hero data={data} onVisualize={onVisualize} />

      <div className="bento">
        {/* ── CONNECTION (echoes the VISA card) ── */}
        <Card span={5} delay={0.02} className="lite">
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
              <StateDotInline online={online} /> {online ? "Online" : "Offline"}
            </span>
            <span className="chip">v{s.version || "—"}</span>
            <span className="chip">{upDays}d uptime</span>
          </div>
          <div style={{ flex: 1 }} />
          <div className="between" style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
            <div>
              <div className="sub" style={{ marginTop: 0 }}>Poll cadence</div>
              <div className="num" style={{ fontWeight: 800, fontSize: 18 }}>5s</div>
            </div>
            <button className="chip" onClick={() => onNav("about")} style={{ color: "var(--accent-deep)" }}>
              <Icon name="lock" size={14} /> Security model
            </button>
          </div>
        </Card>

        {/* ── THROUGHPUT (echoes income/paid) ── */}
        <Card span={4} delay={0.06}>
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
        </Card>

        {/* ── CACHE RING (echoes the dark growth donut) ── */}
        <Card span={3} delay={0.1} className="dark" style={{ alignItems: "center", justifyContent: "center" }}>
          <K>Cache hit rate</K>
          <div style={{ marginTop: 8 }}>
            <Ring pct={u.cache_hit_rate ?? 71} label={(u.cache_hit_rate ?? 71) + "%"} sub="cheaper turns" color="var(--accent)" />
          </div>
        </Card>

        {/* ── SERVER HEALTH ── */}
        <Card span={5} delay={0.14}>
          <K>Server health</K>
          <div style={{ marginTop: 14 }}>
            <Meter label="CPU" pct={h.cpu ?? 24} />
            <Meter label="Memory" pct={h.mem ?? 61} />
            <Meter label="Disk" pct={h.disk ?? 43} />
          </div>
        </Card>

        {/* ── AGENT MEMORY CEILING (the verified #1 frustration) ── */}
        <Card span={4} delay={0.18}>
          <K>Agent memory <span className="muted" style={{ textTransform: "none", letterSpacing: 0, fontFamily: "var(--font)" }}>— fills fast</span></K>
          <div style={{ marginTop: 14 }}>
            <Meter label="User profile" pct={Math.round((mem.user / mem.user_max) * 100) || 0} value={`${mem.user}/${mem.user_max}`} />
            <Meter label="Agent memory" pct={Math.round((mem.agent / mem.agent_max) * 100) || 0} value={`${mem.agent}/${mem.agent_max}`} />
          </div>
          <div className="sub">Near full → wasted turns. Add a memory provider with <code className="mono" style={{ color: "var(--accent-deep)" }}>/hermes-memory</code>.</div>
        </Card>

        {/* ── CAPABILITY HEALTH ── */}
        <Card span={3} delay={0.22}>
          <K>Capability health</K>
          <div style={{ display: "flex", flexDirection: "column", gap: 9, marginTop: 13 }}>
            {Object.entries(cap).map(([n, st]) => {
              const [t, c, bg] = capMap[st] || capMap.ok;
              return (
                <div key={n} className="between">
                  <span style={{ fontWeight: 700, fontSize: 13, whiteSpace: "nowrap" }}>{n}</span>
                  <span className="delta" style={{ background: bg, color: c }}>{t}</span>
                </div>
              );
            })}
          </div>
        </Card>

        {/* ── ACTIVITY 7d AREA ── */}
        <Card span={5} delay={0.24}>
          <div className="between"><K>Activity — last 7 days</K><span className="delta">▲ +12%</span></div>
          <AreaChart data={data.usage.daily.map((d) => d.messages)} color="var(--accent)" height={140} />
        </Card>

        {/* ── VOLUME BY CHANNEL (concentric — the image's signature) ── */}
        <Card span={4} delay={0.28}>
          <div className="between"><K>Volume by channel</K><span className="chip x">7d ▾</span></div>
          <Rings items={[
            { label: fmt(186), v: 186, c: "#FBE3DB" },
            { label: fmt(120), v: 120, c: "#F6C9BC" },
            { label: fmt(64), v: 64, c: "#EE9A82" },
            { label: fmt(28), v: 28, c: "var(--accent)", ink: "#fff" },
          ]} />
        </Card>

        {/* ── UPTIME STREAK (echoes "13 Days") ── */}
        <Card span={3} delay={0.32}>
          <div className="row" style={{ gap: 9 }}>
            <span className="icon-btn" style={{ width: 34, height: 34 }}><Icon name="clock" size={15} /></span>
          </div>
          <div className="big num" style={{ marginTop: 14 }}>{upDays} Days</div>
          <div className="sub">{upDays * 24 + upHrs} hours, {upMin} minutes</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(13,1fr)", gap: 5, marginTop: 14 }}>
            {Array.from({ length: 26 }, (_, i) => (
              <span key={i} style={{ width: "100%", aspectRatio: "1/1", borderRadius: "50%",
                background: i < upDays * 2 ? "var(--accent)" : "var(--line)" }} />
            ))}
          </div>
        </Card>

        {/* ── LIVE THROUGHPUT WAVE (echoes activity manager) ── */}
        <Card span={5} delay={0.34}>
          <div className="between">
            <K>Live throughput</K>
            <div className="row" style={{ gap: 6 }}>
              <span className="chip x">⋮</span><span className="chip x">Filters</span>
            </div>
          </div>
          <div className="row" style={{ gap: 8, marginTop: 14 }}>
            <span className="big num" style={{ fontSize: 34 }}>{(u.tokens ? (u.tokens / u.messages / 1000).toFixed(1) : "8.7")}k</span>
            <span className="sub" style={{ marginTop: 12 }}>tokens / message avg</span>
          </div>
          <Wave n={22} hotAt={13} />
        </Card>

        {/* ── ACTIVE TOOLSETS (echoes "Business plans" list) ── */}
        <Card span={4} delay={0.38}>
          <div className="between"><K>Active toolsets</K><span className="chip x">⋮</span></div>
          <div style={{ display: "flex", flexDirection: "column", gap: 0, marginTop: 6 }}>
            {(caps.toolsets || []).slice(0, 4).map((t, i) => {
              const tool = (window.HData.TOOLS || []).find((x) => x.id === t);
              return (
              <div key={t} className="between" style={{ padding: "11px 0", borderTop: i ? "1px solid var(--line)" : "none" }}>
                <span className="row" style={{ gap: 10, fontWeight: 700, fontSize: 13.5 }}>
                  <span style={{ width: 26, height: 26, borderRadius: "50%", background: "var(--accent)", color: "#fff", display: "grid", placeItems: "center" }}>
                    <Icon name={tool ? tool.glyph : toolGlyph(t)} size={13} />
                  </span>{tool ? tool.label : t}
                </span>
                <span className="chip x" style={{ fontSize: 11 }}>▾</span>
              </div>
              );
            })}
          </div>
        </Card>

        {/* ── AGENT HEALTH SENTIMENT (echoes review rating) ── */}
        <Card span={3} delay={0.42} className="lite">
          <div className="between"><K>Overall</K><span className="chip x">✕</span></div>
          <div className="sub" style={{ marginTop: 14 }}>How is your agent doing?</div>
          <div style={{ fontWeight: 800, fontSize: 19, letterSpacing: "-.02em", marginTop: 4, lineHeight: 1.2 }}>
            {online ? "Healthy & responsive" : "Needs attention"}
          </div>
          <div className="row" style={{ gap: 8, marginTop: 16 }}>
            {["😟", "🙁", "😐", "🙂", "😄"].map((e, i) => (
              <span key={i} className="icon-btn" style={{ width: 40, height: 40, fontSize: 17, opacity: i === (online ? 4 : 1) ? 1 : 0.4, borderColor: i === (online ? 4 : 1) ? "var(--accent)" : "var(--line)" }}>{e}</span>
            ))}
          </div>
        </Card>

        {/* ── RECENT ACTIVITY LEDGER ── */}
        <Card span={12} delay={0.46} className="ledger">
          <div className="hd">
            <h3>Recent activity</h3>
            <button className="chip x" onClick={() => onNav("ledger")}>View full ledger ↗</button>
          </div>
          <table>
            <thead><tr><th>When</th><th>Channel</th><th>What happened</th><th>Tool</th><th className="t-right">Tokens</th></tr></thead>
            <tbody>
              {data.sessions.slice(0, 6).map((row) => (
                <tr key={row.id}>
                  <td className="muted num" style={{ fontSize: 12.5 }}>{(row.updated || "").slice(11, 16) || "—"}</td>
                  <td><span className="chan"><span className="dotmark" style={{ background: PLAT_COLOR[row.platform] || "var(--accent)" }} />{row.platform || "agent"}</span></td>
                  <td>{row.summary || row.title || "activity"}</td>
                  <td><code className="mono" style={{ fontSize: 11.5, background: "var(--card-2)", padding: "2px 6px", borderRadius: 6 }}>{row.tool || "—"}</code></td>
                  <td className="t-right num">{fmt(row.tokens || 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  );
}

function StateDotInline({ online }) {
  return <span className="dotmark bp" style={{ background: online ? "var(--ok)" : "var(--accent)" }} />;
}
function toolGlyph(t) {
  const m = { web: "search", browser: "radio", terminal: "terminal", code: "code", memory: "database", channels: "mail", media: "eye", cron: "cal", orchestration: "share", mcp: "cpu" };
  return m[t] || "grid";
}

Object.assign(window, { Overview, toolGlyph });
