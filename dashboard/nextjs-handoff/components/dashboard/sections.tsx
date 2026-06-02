"use client";
import * as React from "react";
import { Card } from "@/components/ui/card";
import { BorderBeam } from "@/components/ui/border-beam";
import { TOOLS, type Bundle } from "@/lib/hermes";

const fmt = (n = 0) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : Math.round(n).toString());
const PLAT: Record<string, string> = { Telegram: "#229ED9", Discord: "#5865F2", WhatsApp: "#25D366", Slack: "#611f69" };
const K = ({ children }: { children: React.ReactNode }) => <div className="num" style={{ fontSize: 10.5, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--ink-soft)", fontWeight: 700 }}>{children}</div>;
function Meter({ label, pct, value }: { label: string; pct: number; value?: string }) {
  const col = pct > 90 ? "var(--bad)" : pct > 72 ? "var(--warn)" : "var(--ok)";
  return (
    <div style={{ marginBottom: 13 }}>
      <div className="flex justify-between text-[13px]"><span style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{label}</span><span className="num" style={{ color: "var(--ink-soft)" }}>{value ?? pct + "%"}</span></div>
      <div style={{ height: 8, background: "var(--line-soft)", borderRadius: 99, overflow: "hidden", marginTop: 6 }}><span style={{ display: "block", height: "100%", width: pct + "%", background: col, borderRadius: 99 }} /></div>
    </div>
  );
}

export function Overview({ data }: { data: Bundle }) {
  const s = data.status; const online = typeof s.gateway === "object" ? s.gateway?.running ?? true : true;
  const u = data.usage.totals || {}; const h = s.health || {}; const mem = s.memory || {}; const cap = s.capabilities || {};
  const live = (s.platforms || []).filter((p) => p.connected).length;
  const upDays = Math.floor((s.uptime_seconds || 0) / 86400);
  const capMap: Record<string, [string, string, string]> = { ok: ["OK", "var(--ok)", "var(--ok-soft)"], degraded: ["No key", "var(--accent-deep)", "var(--accent-soft)"], off: ["Off", "var(--ink-soft)", "var(--line-soft)"] };
  return (
    <div className="grid grid-cols-12 gap-4">
      <Card className="col-span-12 lg:col-span-5 p-5 relative overflow-hidden bg-[var(--card-2)]">
        {online && <BorderBeam size={120} duration={8} />}
        <div className="flex items-center justify-between"><div className="flex items-center gap-2 font-extrabold text-[15px]">⚡ Hermes Gateway</div><span className="text-[12px] text-[var(--ink-soft)]">Read-only ▾</span></div>
        <div className="text-[13px] text-[var(--ink-soft)] mt-4">Bound to a private address</div>
        <div className="num text-[22px] font-extrabold mt-1">127.0.0.1 : 9119</div>
        <div className="flex gap-2 mt-4 text-[12.5px] font-bold">
          <span className="px-3 py-1.5 rounded-full text-white" style={{ background: "var(--ink-dark)" }}>{online ? "● Online" : "● Offline"}</span>
          <span className="px-3 py-1.5 rounded-full" style={{ background: "var(--card)" }}>v{s.version}</span>
          <span className="px-3 py-1.5 rounded-full" style={{ background: "var(--card)" }}>{upDays}d uptime</span>
        </div>
      </Card>
      <Card className="col-span-6 lg:col-span-4 p-5"><K>Messages · 7d</K><div className="num text-[40px] font-extrabold leading-none mt-2">{fmt(u.messages)}</div><div style={{ height: 1, background: "var(--line)", margin: "16px 0" }} /><K>Tokens · 7d</K><div className="num text-[40px] font-extrabold leading-none mt-2">{fmt(u.tokens)}</div></Card>
      <Card className="col-span-6 lg:col-span-3 p-5 text-white grid place-items-center" style={{ background: "var(--ink-dark)" }}><K>Cache hit rate</K><div className="num text-[44px] font-extrabold mt-2">{u.cache_hit_rate ?? 71}%</div><div className="text-[11px] text-[#A89F8E]">cheaper turns</div></Card>
      <Card className="col-span-12 lg:col-span-5 p-5"><K>Server health</K><div className="mt-3"><Meter label="CPU" pct={h.cpu ?? 24} /><Meter label="Memory" pct={h.mem ?? 61} /><Meter label="Disk" pct={h.disk ?? 43} /></div></Card>
      <Card className="col-span-12 lg:col-span-4 p-5"><K>Agent memory</K><div className="mt-3"><Meter label="User profile" pct={Math.round(((mem.user || 0) / (mem.user_max || 1)) * 100)} value={`${mem.user}/${mem.user_max}`} /><Meter label="Agent memory" pct={Math.round(((mem.agent || 0) / (mem.agent_max || 1)) * 100)} value={`${mem.agent}/${mem.agent_max}`} /></div></Card>
      <Card className="col-span-12 lg:col-span-3 p-5"><K>Capability health</K><div className="flex flex-col gap-2.5 mt-3">{Object.entries(cap).map(([n, st]) => { const [t, c, bg] = capMap[st] || capMap.ok; return <div key={n} className="flex justify-between items-center"><span className="font-bold text-[13px] whitespace-nowrap">{n}</span><span className="num text-[11.5px] font-extrabold px-2 py-0.5 rounded-lg" style={{ background: bg, color: c }}>{t}</span></div>; })}</div></Card>
      <Card className="col-span-12 p-0 overflow-hidden">
        <div className="flex items-center justify-between p-5 pb-3"><h3 className="font-extrabold text-[18px]">Recent activity</h3><span className="text-[12px] text-[var(--ink-soft)]">{live} channels live</span></div>
        <table className="w-full border-collapse"><thead><tr>{["When", "Channel", "What happened", "Tool", "Tokens"].map((c, i) => <th key={c} className={`num text-[10px] uppercase tracking-wide text-[var(--ink-soft)] font-bold px-5 py-2 ${i === 4 ? "text-right" : "text-left"}`}>{c}</th>)}</tr></thead>
          <tbody>{data.sessions.slice(0, 6).map((r) => (
            <tr key={r.id} className="border-t border-[var(--line)]">
              <td className="num text-[12.5px] text-[var(--ink-soft)] px-5 py-3">{(r.updated || "").slice(11, 16)}</td>
              <td className="px-5 py-3"><span className="inline-flex items-center gap-2 font-bold text-[13px]"><span className="w-2 h-2 rounded-full" style={{ background: PLAT[r.platform || ""] || "var(--accent)" }} />{r.platform}</span></td>
              <td className="px-5 py-3 text-[13.5px]">{r.summary}</td>
              <td className="px-5 py-3"><code className="num text-[11.5px] px-1.5 py-0.5 rounded" style={{ background: "var(--card-2)" }}>{r.tool}</code></td>
              <td className="num px-5 py-3 text-right text-[13.5px]">{fmt(r.tokens)}</td>
            </tr>))}</tbody></table>
      </Card>
    </div>
  );
}

export function Channels({ data }: { data: Bundle }) {
  return (
    <div className="grid grid-cols-12 gap-4">
      {(data.status.platforms || []).map((p) => (
        <Card key={p.name} className="col-span-12 sm:col-span-6 lg:col-span-3 p-5">
          <div className="flex items-center justify-between"><span className="inline-flex items-center gap-2 font-bold text-[15px]"><span className="w-2 h-2 rounded-full" style={{ background: p.connected ? PLAT[p.name] : "var(--ink-faint)" }} />{p.name}</span><span className="num text-[11.5px] font-extrabold px-2 py-0.5 rounded-lg" style={{ background: p.connected ? "var(--ok-soft)" : "var(--line-soft)", color: p.connected ? "var(--ok)" : "var(--ink-soft)" }}>{p.connected ? "Live" : "Off"}</span></div>
          <div className="text-[13px] text-[var(--ink-soft)] mt-2">{p.connected ? "Reachable now." : "Not set up yet."}</div>
          <code className="num text-[11.5px] mt-3 inline-block px-2.5 py-1.5 rounded-lg" style={{ background: "var(--card-2)", color: "var(--accent-deep)" }}>/platform-{p.name.toLowerCase()}</code>
        </Card>
      ))}
    </div>
  );
}

export function Schedule({ data }: { data: Bundle }) {
  return (
    <Card className="p-0 overflow-hidden">
      <table className="w-full border-collapse"><thead><tr>{["Task", "Runs", "Next", "Status"].map((c, i) => <th key={c} className={`num text-[10px] uppercase tracking-wide text-[var(--ink-soft)] font-bold px-5 py-3 ${i === 3 ? "text-right" : "text-left"}`}>{c}</th>)}</tr></thead>
        <tbody>{data.cron.map((j) => (<tr key={j.id} className="border-t border-[var(--line)]"><td className="px-5 py-3 font-bold text-[13.5px]">{j.name}</td><td className="num px-5 py-3 text-[var(--ink-soft)]">{j.schedule}</td><td className="px-5 py-3 text-[var(--ink-soft)]">{j.next_run}</td><td className="px-5 py-3 text-right"><span className="num text-[11.5px] font-extrabold px-2 py-0.5 rounded-lg" style={j.paused ? { background: "var(--warn-soft)", color: "var(--warn)" } : { background: "var(--ok-soft)", color: "var(--ok)" }}>{j.paused ? "Paused" : "Active"}</span></td></tr>))}</tbody></table>
    </Card>
  );
}

export function Ledger({ data }: { data: Bundle }) {
  return (
    <Card className="p-0 overflow-hidden">
      <table className="w-full border-collapse"><thead><tr>{["When", "Channel", "What happened", "Tool", "Tokens"].map((c, i) => <th key={c} className={`num text-[10px] uppercase tracking-wide text-[var(--ink-soft)] font-bold px-5 py-3 ${i === 4 ? "text-right" : "text-left"}`}>{c}</th>)}</tr></thead>
        <tbody>{data.sessions.map((r) => (<tr key={r.id} className="border-t border-[var(--line)]"><td className="num text-[12.5px] text-[var(--ink-soft)] px-5 py-3">{(r.updated || "").slice(5, 16)}</td><td className="px-5 py-3"><span className="inline-flex items-center gap-2 font-bold text-[13px]"><span className="w-2 h-2 rounded-full" style={{ background: PLAT[r.platform || ""] || "var(--accent)" }} />{r.platform}</span></td><td className="px-5 py-3 text-[13.5px]">{r.summary}</td><td className="px-5 py-3"><code className="num text-[11.5px] px-1.5 py-0.5 rounded" style={{ background: "var(--card-2)" }}>{r.tool}</code></td><td className="num px-5 py-3 text-right">{fmt(r.tokens)}</td></tr>))}</tbody></table>
    </Card>
  );
}

export function Usage({ data }: { data: Bundle }) {
  const u = data.usage.totals || {}; const daily = data.usage.daily || [];
  const max = Math.max(...daily.map((d) => d.cost), 0.01);
  return (
    <div className="grid grid-cols-12 gap-4">
      {[["Messages 7d", fmt(u.messages)], ["Tokens 7d", fmt(u.tokens)], ["Est. cost 7d", "$" + (u.cost ?? 0).toFixed(2)], ["Cache hits", (u.cache_hit_rate ?? 71) + "%"]].map(([k, v]) => (
        <Card key={k} className="col-span-6 lg:col-span-3 p-5"><K>{k}</K><div className="num text-[36px] font-extrabold mt-2">{v}</div></Card>
      ))}
      <Card className="col-span-12 p-5"><K>Daily cost</K>
        <div className="flex items-end gap-2 h-[150px] mt-4">{daily.map((d, i) => <div key={i} className="flex-1 flex flex-col items-center gap-1"><div style={{ width: "100%", height: `${(d.cost / max) * 100}%`, minHeight: 5, borderRadius: "4px 4px 0 0", background: i === 5 ? "var(--warn)" : "var(--line)" }} /><span className="num text-[9px] text-[var(--ink-faint)]">{d.day}</span></div>)}</div>
        <p className="text-[13px] text-[var(--ink-soft)] mt-3">Climbing? Switch to a cheaper model with <code className="num text-[var(--accent-deep)]">/hermes-model</code>.</p>
      </Card>
    </div>
  );
}

export function About() {
  return (
    <div className="grid grid-cols-12 gap-4">
      <Card className="col-span-12 p-6" style={{ background: "linear-gradient(135deg,var(--card-2),var(--accent-tint))" }}>
        <h3 className="text-[22px] font-extrabold tracking-tight">hstack turns Claude Code into the engineer who <span style={{ color: "var(--accent-deep)" }}>sets up your self-hosted AI agent</span>.</h3>
        <p className="text-[14px] text-[var(--ink-soft)] max-w-[720px] mt-2.5">You paste one command; it runs the whole setup end-to-end and only stops for the ~5 things a machine can&apos;t do: mint a token, paste a key, scan a QR, click OAuth, send the first &quot;hello.&quot;</p>
      </Card>
      <Card className="col-span-12 lg:col-span-6 p-5"><K>Why this dashboard is safe</K><p className="text-[14px] text-[var(--ink-soft)] mt-2">It only issues <b>GET</b> requests against Hermes&apos; :9119 dashboard API — it cannot change or restart your agent. Reach it over an SSH tunnel or behind an HTTPS + password proxy; never expose :9119 raw.</p></Card>
      <Card className="col-span-12 lg:col-span-6 p-5"><K>Toolsets</K><div className="toolgrid">{TOOLS.map((t) => <div key={t.id} className="tl"><span className="ti">▣</span>{t.label}</div>)}</div></Card>
    </div>
  );
}
