/* sections.jsx — Channels · Schedule · Activity Ledger · Usage & Cost · About */

function SectionHead({ title, sub }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <h2 style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-.03em" }}>{title}</h2>
      {sub && <div className="sub" style={{ marginTop: 4, fontSize: 14 }}>{sub}</div>}
    </div>
  );
}

/* ── CHANNELS ── */
function Channels({ data }) {
  const plats = data.status.platforms || [];
  return (
    <div>
      <SectionHead title="Channels" sub="Where people can reach your agent right now. A green dot means it's live." />
      <div className="bento">
        {plats.map((p, i) => (
          <Card key={p.name} span={3} delay={0.04 + i * 0.04}>
            <div className="between">
              <span className="chan" style={{ fontSize: 15 }}>
                <span className="dotmark" style={{ background: p.connected ? PLAT_COLOR[p.name] : "var(--ink-faint)" }} />{p.name}
              </span>
              <span className="delta" style={{ background: p.connected ? "var(--ok-soft)" : "var(--line-soft)", color: p.connected ? "var(--ok)" : "var(--ink-soft)" }}>
                {p.connected ? "Live" : "Off"}
              </span>
            </div>
            <div className="sub" style={{ flex: 1 }}>{p.connected ? "Reachable now — messages route to the agent." : "Not set up yet."}</div>
            <code className="mono" style={{ marginTop: 14, fontSize: 11.5, color: "var(--accent-deep)", background: "var(--card-2)", padding: "6px 10px", borderRadius: 8 }}>
              /platform-{p.name.toLowerCase()}
            </code>
          </Card>
        ))}
        <Card span={12}>
          <K>In plain words</K>
          <p className="sub" style={{ fontSize: 14, marginTop: 8 }}>
            To add a channel, tell Claude Code its setup command (above). hstack handles the token, allowlist and gateway restart for you — this view only <b>reads</b> connection state, it never changes it.
          </p>
        </Card>
      </div>
    </div>
  );
}

/* ── SCHEDULE ── */
function Schedule({ data }) {
  const jobs = data.cron || [];
  return (
    <div>
      <SectionHead title="Scheduled tasks" sub="Jobs your agent runs on a timer (read-only view)." />
      <Card span={12} className="ledger">
        <table>
          <thead><tr><th>Task</th><th>Runs</th><th>Next</th><th className="t-right">Status</th></tr></thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td><b>{j.name || j.prompt || j.id}</b></td>
                <td className="muted num">{j.schedule || "—"}</td>
                <td className="muted">{j.next_run || "—"}</td>
                <td className="t-right">
                  <span className="delta" style={j.paused ? { background: "var(--warn-soft)", color: "var(--warn)" } : {}}>
                    {j.paused ? "Paused" : "Active"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

/* ── ACTIVITY LEDGER ── */
function Ledger({ data }) {
  const [q, setQ] = useState("");
  const rows = data.sessions.filter((s) =>
    !q || (s.summary || "").toLowerCase().includes(q.toLowerCase()) || (s.platform || "").toLowerCase().includes(q.toLowerCase()) || (s.tool || "").toLowerCase().includes(q.toLowerCase())
  );
  return (
    <div>
      <SectionHead title="Activity ledger" sub="Every recent session, with tool calls and token cost." />
      <div className="topbar-search" style={{ marginBottom: 16 }}>
        <div className="search" style={{ maxWidth: 360 }}>
          <Icon name="search" size={16} />
          <input placeholder="Search activity…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <Card span={12} className="ledger">
        <table>
          <thead><tr><th>When</th><th>Channel</th><th>What happened</th><th>Tool</th><th className="t-right">Tokens</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="muted num" style={{ fontSize: 12.5 }}>{(row.updated || "").slice(5, 16) || "—"}</td>
                <td><span className="chan"><span className="dotmark" style={{ background: PLAT_COLOR[row.platform] || "var(--accent)" }} />{row.platform || "agent"}</span></td>
                <td>{row.summary}</td>
                <td><code className="mono" style={{ fontSize: 11.5, background: "var(--card-2)", padding: "2px 6px", borderRadius: 6 }}>{row.tool || "—"}</code></td>
                <td className="t-right num">{fmt(row.tokens || 0)}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan="5" className="muted" style={{ textAlign: "center", padding: 30 }}>No matches.</td></tr>}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

/* ── USAGE & COST ── */
function Usage({ data }) {
  const u = data.usage.totals || {};
  return (
    <div>
      <SectionHead title="Usage & cost" sub="Token spend over the last 7 days. Climbing? Switch models." />
      <div className="bento">
        <Card span={3} delay={0.02}><K>Messages 7d</K><div className="big num">{fmt(u.messages ?? 0)}</div></Card>
        <Card span={3} delay={0.06}><K>Tokens 7d</K><div className="big num">{fmt(u.tokens ?? 0)}</div></Card>
        <Card span={3} delay={0.1}><K>Est. cost 7d</K><div className="big num">${(u.cost ?? 0).toFixed(2)}</div></Card>
        <Card span={3} delay={0.14}><K>Cache hits</K><div className="big num">{u.cache_hit_rate ?? 71}%</div></Card>

        <Card span={8} delay={0.18}>
          <K>Daily cost</K>
          <AreaChart data={data.usage.daily.map((d) => d.cost)} color="var(--warn)" height={150} />
          <p className="sub" style={{ marginTop: 10 }}>
            Climbing? Switch to a cheaper model with <code className="mono" style={{ color: "var(--accent-deep)" }}>/hermes-model</code> (DeepSeek V4 is the cheapest high-quality option).
          </p>
        </Card>
        <Card span={4} delay={0.22}>
          <K>Messages / day</K>
          <Bars data={data.usage.daily.map((d, i) => ({ v: d.messages, label: d.day, hot: i === 5 }))} height={150} />
        </Card>
      </div>
    </div>
  );
}

/* ── ABOUT hstack ── */
function About() {
  return (
    <div>
      <SectionHead title="What is hstack?" />
      <div className="bento">
        <Card span={12} style={{ background: "linear-gradient(135deg,var(--card-2),var(--accent-tint))" }}>
          <h3 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-.02em" }}>
            hstack turns Claude Code into the engineer who <span style={{ color: "var(--accent-deep)" }}>sets up your self-hosted AI agent</span> for you.
          </h3>
          <p className="sub" style={{ fontSize: 14, maxWidth: 720, marginTop: 10 }}>
            Deploying a Hermes Agent — your own AI on Telegram, WhatsApp or Discord, on your own server — is genuinely painful: Docker, model config, platform tokens, allowlists, gateway crashes. You paste <b>one command</b>; it runs the whole setup end-to-end and only stops for the ~5 things a machine can't do: mint a token, paste a key, scan a QR, click OAuth, send the first "hello."
          </p>
          <div className="steps">
            <div className="step"><b>1</b> Paste one command</div>
            <div className="step"><b>2</b> Answer ~5 prompts</div>
            <div className="step"><b>3</b> Agent live on your phone</div>
            <div className="step"><b>4</b> This dashboard watches it</div>
          </div>
        </Card>
        <Card span={6}>
          <K>Why it's reliable</K>
          <p className="sub" style={{ fontSize: 14, marginTop: 8 }}>
            hstack already knows every trap — the WhatsApp LID bug, the stale gateway lock, the Chromium install failure, the OAuth-vs-API-key fork. It pins a known-good Hermes version (v0.15.0) and verifies every step.
          </p>
        </Card>
        <Card span={6}>
          <K>Why this dashboard is safe</K>
          <p className="sub" style={{ fontSize: 14, marginTop: 8 }}>
            It only ever issues <b>GET</b> requests against Hermes' own dashboard API on port 9119 — it cannot change or restart your agent. Reach it over an SSH tunnel or behind an HTTPS + password proxy; never expose port 9119 to the open internet.
          </p>
        </Card>
      </div>
    </div>
  );
}

Object.assign(window, { Channels, Schedule, Ledger, Usage, About, SectionHead });
