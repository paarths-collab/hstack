"use client";
import * as React from "react";
import type { Bundle } from "@/lib/hermes";
import { BentoCard, K, fmt, PLAT_COLOR } from "./charts";

function SectionHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <h2 style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-.03em", margin: 0 }}>{title}</h2>
      {sub && <div className="sub" style={{ marginTop: 4, fontSize: 14 }}>{sub}</div>}
    </div>
  );
}

// ── CHANNELS ─────────────────────────────────────────────────────────────────
export function Channels({ data }: { data: Bundle }) {
  const plats = data.status.platforms || [];
  return (
    <div>
      <SectionHead title="Channels" sub="Where people can reach your agent right now. A green dot means it's live." />
      <div className="bento">
        {plats.map((p, i) => (
          <BentoCard key={p.name} span={3} delay={0.04 + i * 0.04}>
            <div className="between">
              <span className="chan" style={{ fontSize: 15 }}>
                <span className="dotmark" style={{ background: p.connected ? (PLAT_COLOR[p.name] || "var(--ok)") : "var(--ink-faint)" }} />
                {p.name}
              </span>
              <span className="delta" style={p.connected ? {} : { background: "var(--line-soft)", color: "var(--ink-soft)" }}>
                {p.connected ? "Live" : "Off"}
              </span>
            </div>
            <div className="sub" style={{ flex: 1, marginTop: 10 }}>
              {p.connected ? "Reachable now — messages route to the agent." : "Not set up yet."}
            </div>
            <code className="mono" style={{
              marginTop: 14, fontSize: 11.5, color: "var(--accent-deep)",
              background: "var(--card-2)", padding: "6px 10px", borderRadius: 8, display: "block",
            }}>
              /platform-{p.name.toLowerCase()}
            </code>
          </BentoCard>
        ))}
        <BentoCard span={12}>
          <K>In plain words</K>
          <p className="sub" style={{ fontSize: 14, marginTop: 8 }}>
            To add a channel, tell Claude Code its setup command (above). hstack handles the token, allowlist
            and gateway restart for you — this view only <b style={{ color: "var(--ink)" }}>reads</b> connection
            state, it never changes it.
          </p>
        </BentoCard>
      </div>
    </div>
  );
}

// ── SCHEDULE ─────────────────────────────────────────────────────────────────
export function Schedule({ data }: { data: Bundle }) {
  const jobs = data.cron || [];
  return (
    <div>
      <SectionHead title="Scheduled tasks" sub="Jobs your agent runs on a timer (read-only view)." />
      <BentoCard span={12} className=" ledger">
        <table>
          <thead>
            <tr><th>Task</th><th>Runs</th><th>Next</th><th className="t-right">Status</th></tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td><b>{j.name || j.id}</b></td>
                <td className="muted num">{j.schedule || "—"}</td>
                <td className="muted">{j.next_run || "—"}</td>
                <td className="t-right">
                  <span className="delta" style={j.paused ? { background: "var(--warn-soft)", color: "var(--warn)" } : {}}>
                    {j.paused ? "Paused" : "Active"}
                  </span>
                </td>
              </tr>
            ))}
            {!jobs.length && (
              <tr><td colSpan={4} className="muted" style={{ textAlign: "center", padding: 30 }}>No scheduled jobs.</td></tr>
            )}
          </tbody>
        </table>
      </BentoCard>
    </div>
  );
}

// ── LEDGER ────────────────────────────────────────────────────────────────────
export function Ledger({ data }: { data: Bundle }) {
  const [q, setQ] = React.useState("");
  const rows = data.sessions.filter((s) =>
    !q || (s.summary || "").toLowerCase().includes(q.toLowerCase()) ||
    (s.platform || "").toLowerCase().includes(q.toLowerCase()) ||
    (s.tool || "").toLowerCase().includes(q.toLowerCase()),
  );
  return (
    <div>
      <SectionHead title="Activity ledger" sub="Every recent session, with tool calls and token cost." />
      <div style={{ marginBottom: 16, maxWidth: 360 }}>
        <div className="topbar search" style={{ borderRadius: 99, padding: "9px 16px", minWidth: 0, background: "var(--card)", border: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 10, color: "var(--ink-faint)" }}>
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3" />
          </svg>
          <input
            placeholder="Search activity…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ border: "none", background: "none", font: "inherit", color: "var(--ink)", outline: "none", width: "100%" }}
          />
        </div>
      </div>
      <BentoCard span={12} className=" ledger">
        <table>
          <thead>
            <tr><th>When</th><th>Channel</th><th>What happened</th><th>Tool</th><th className="t-right">Tokens</th></tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="muted num" style={{ fontSize: 12.5 }}>{(row.updated || "").slice(5, 16) || "—"}</td>
                <td>
                  <span className="chan">
                    <span className="dotmark" style={{ background: PLAT_COLOR[row.platform || ""] || "var(--accent)" }} />
                    {row.platform || "agent"}
                  </span>
                </td>
                <td>{row.summary}</td>
                <td>
                  <code className="mono" style={{ fontSize: 11.5, background: "var(--card-2)", padding: "2px 6px", borderRadius: 6 }}>
                    {row.tool || "—"}
                  </code>
                </td>
                <td className="t-right num">{fmt(row.tokens || 0)}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr><td colSpan={5} className="muted" style={{ textAlign: "center", padding: 30 }}>No matches.</td></tr>
            )}
          </tbody>
        </table>
      </BentoCard>
    </div>
  );
}

// ── USAGE & COST ──────────────────────────────────────────────────────────────
import { AreaChart, Bars } from "./charts";

export function Usage({ data }: { data: Bundle }) {
  const u = data.usage.totals || {};
  const daily = data.usage.daily || [];
  return (
    <div>
      <SectionHead title="Usage & cost" sub="Token spend over the last 7 days. Climbing? Switch models." />
      <div className="bento">
        <BentoCard span={3} delay={0.02}><K>Messages 7d</K><div className="big num">{fmt(u.messages ?? 0)}</div></BentoCard>
        <BentoCard span={3} delay={0.06}><K>Tokens 7d</K><div className="big num">{fmt(u.tokens ?? 0)}</div></BentoCard>
        <BentoCard span={3} delay={0.1}><K>Est. cost 7d</K><div className="big num">${(u.cost ?? 0).toFixed(2)}</div></BentoCard>
        <BentoCard span={3} delay={0.14}><K>Cache hits</K><div className="big num">{u.cache_hit_rate ?? 71}%</div></BentoCard>

        <BentoCard span={8} delay={0.18}>
          <K>Daily cost (USD)</K>
          <AreaChart data={daily.map((d) => d.cost)} color="var(--warn)" height={150} />
          <p className="sub" style={{ marginTop: 10 }}>
            Climbing? Switch to a cheaper model with{" "}
            <code className="mono" style={{ color: "var(--accent-deep)", fontSize: 11 }}>/hermes-model</code>.
          </p>
        </BentoCard>
        <BentoCard span={4} delay={0.22}>
          <K>Messages / day</K>
          <Bars
            data={daily.map((d, i) => ({ v: d.messages, label: d.day, hot: i === daily.length - 2 }))}
            height={150}
          />
        </BentoCard>
      </div>
    </div>
  );
}

// ── ABOUT ─────────────────────────────────────────────────────────────────────
export function About() {
  return (
    <div>
      <SectionHead title="What is hstack?" />
      <div className="bento">
        <BentoCard span={12} style={{ background: "linear-gradient(135deg,var(--card-2),var(--accent-tint))" }}>
          <h3 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-.02em" }}>
            hstack turns Claude Code into the engineer who{" "}
            <span style={{ color: "var(--accent-deep)" }}>sets up your self-hosted AI agent</span> for you.
          </h3>
          <p className="sub" style={{ fontSize: 14, maxWidth: 720, marginTop: 10 }}>
            Deploying a Hermes Agent — your own AI on Telegram, WhatsApp or Discord, on your own server — is genuinely painful:
            Docker, model config, platform tokens, allowlists, gateway crashes. You paste <b style={{ color: "var(--ink)" }}>one command</b>;
            it runs the whole setup end-to-end and only stops for the ~5 things a machine can't do: mint a token, paste a key, scan a QR,
            click OAuth, send the first "hello."
          </p>
          <div className="steps">
            <div className="step"><b>1</b> Paste one command</div>
            <div className="step"><b>2</b> Answer ~5 prompts</div>
            <div className="step"><b>3</b> Agent live on your phone</div>
            <div className="step"><b>4</b> This dashboard watches it</div>
          </div>
        </BentoCard>

        <BentoCard span={6}>
          <K>Why it's reliable</K>
          <p className="sub" style={{ fontSize: 14, marginTop: 8 }}>
            hstack already knows every trap — the stale gateway lock, the Chromium install failure, the OAuth-vs-API-key fork.
            It pins a verified Hermes version (v0.15.2) and validates every step before moving on.
          </p>
        </BentoCard>

        <BentoCard span={6}>
          <K>Why this dashboard is safe</K>
          <p className="sub" style={{ fontSize: 14, marginTop: 8 }}>
            It only ever issues <b style={{ color: "var(--ink)" }}>GET</b> requests against Hermes' own dashboard API on port 9119 —
            it cannot change or restart your agent. Reach it over an SSH tunnel or behind HTTPS + auth; never expose port 9119 to
            the open internet.
          </p>
        </BentoCard>

        <BentoCard span={12} className=" lite">
          <K>In collaboration</K>
          <p className="sub" style={{ fontSize: 14, marginTop: 8 }}>
            Built by <b style={{ color: "var(--ink)" }}>Paarth</b> in collaboration with{" "}
            <a href="https://www.digitalcrew.tech/en" target="_blank" rel="noreferrer"
              style={{ color: "var(--accent-deep)", fontWeight: 700 }}>Digital Crew Technology</a>.
            MIT licensed. No telemetry. Self-hosted from day one.
          </p>
        </BentoCard>
      </div>
    </div>
  );
}
