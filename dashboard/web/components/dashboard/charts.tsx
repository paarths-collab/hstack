"use client";
import * as React from "react";

// ── helpers ──────────────────────────────────────────────────────────────────
export const fmt = (n: number) =>
  n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(Math.round(n));

export const PLAT_COLOR: Record<string, string> = {
  Telegram: "#229ED9", Discord: "#5865F2", WhatsApp: "#25D366",
  Slack: "#611f69", Signal: "#3A76F0", agent: "var(--accent)",
};

// ── K label ──────────────────────────────────────────────────────────────────
export function K({ children }: { children: React.ReactNode }) {
  return <div className="k">{children}</div>;
}

// ── BentoCard ────────────────────────────────────────────────────────────────
export function BentoCard({
  span = 12, rows, delay, className = "", style = {}, children,
}: {
  span?: number; rows?: number; delay?: number; className?: string;
  style?: React.CSSProperties; children: React.ReactNode;
}) {
  const s: React.CSSProperties = { gridColumn: `span ${span}`, ...style };
  if (rows) s.gridRow = `span ${rows}`;
  if (delay != null) s.animationDelay = delay + "s";
  return <div className={`card${delay != null ? " reveal" : ""}${className ? " " + className : ""}`} style={s}>{children}</div>;
}

// ── StatePill ─────────────────────────────────────────────────────────────────
export function StatePill({ online }: { online: boolean }) {
  return (
    <span className="chip" style={{
      background: online ? "var(--ok-soft)" : "var(--accent-soft)",
      color: online ? "var(--ok)" : "var(--accent-deep)", border: "none", fontWeight: 800,
    }}>
      <span className="dotmark bp" style={{ background: online ? "var(--ok)" : "var(--accent-deep)" }} />
      {online ? "Online" : "Offline"}
    </span>
  );
}

// ── Meter ────────────────────────────────────────────────────────────────────
export function Meter({ pct, label, value, color }: { pct: number; label: string; value?: string; color?: string }) {
  const col = color || (pct > 90 ? "var(--bad)" : pct > 72 ? "var(--warn)" : "var(--ok)");
  return (
    <div style={{ marginBottom: 13 }}>
      <div className="between" style={{ fontSize: 13 }}>
        <span style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{label}</span>
        <span className="num" style={{ color: "var(--ink-soft)" }}>{value ?? pct + "%"}</span>
      </div>
      <div className="meter"><span style={{ width: pct + "%", background: col }} /></div>
    </div>
  );
}

// ── AreaChart ─────────────────────────────────────────────────────────────────
export function AreaChart({ data, color = "var(--accent)", height = 150 }: {
  data: number[]; color?: string; height?: number;
}) {
  const W = 600, H = height, pad = 8;
  const max = Math.max(...data, 1);
  const step = W / Math.max(data.length - 1, 1);
  const pts = data.map((d, i) => [i * step, H - (d / max) * (H - pad * 2) - pad]);
  const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const fill = line + ` L${W} ${H} L0 ${H} Z`;
  const gid = "ag" + Math.round(color.length * 7 + data.length + data[0]);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height, display: "block", overflow: "visible" }}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity=".26" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={fill} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
        strokeDasharray="1600" strokeDashoffset="1600">
        <animate attributeName="stroke-dashoffset" to="0" dur="1.05s" fill="freeze"
          calcMode="spline" keySplines=".2 .8 .2 1" keyTimes="0;1" values="1600;0" />
      </path>
      {pts.map((p, i) => <circle key={i} cx={p[0].toFixed(1)} cy={p[1].toFixed(1)} r="3" fill={color} />)}
    </svg>
  );
}

// ── Ring ─────────────────────────────────────────────────────────────────────
export function Ring({ pct, label, sub, color = "var(--accent)" }: {
  pct: number; label: string; sub?: string; color?: string;
}) {
  const R = 52, C = 2 * Math.PI * R, len = (pct / 100) * C;
  return (
    <div style={{ position: "relative", width: 140, height: 140 }}>
      <svg viewBox="0 0 140 140" width="140" height="140">
        <circle cx="70" cy="70" r={R} fill="none" stroke="rgba(255,255,255,.14)" strokeWidth="13" />
        <circle cx="70" cy="70" r={R} fill="none" stroke={color} strokeWidth="13" strokeLinecap="round"
          strokeDasharray={`${len} ${C - len}`} transform="rotate(-90 70 70)">
          <animate attributeName="stroke-dasharray" from={`0 ${C}`} to={`${len} ${C - len}`} dur="1s" fill="freeze"
            calcMode="spline" keySplines=".2 .8 .2 1" keyTimes="0;1" />
        </circle>
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", textAlign: "center" }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 26, letterSpacing: "-.02em" }} className="num">{label}</div>
          {sub && <div style={{ fontSize: 11, color: "var(--ink-soft)", marginTop: 2 }}>{sub}</div>}
        </div>
      </div>
    </div>
  );
}

// ── Rings (concentric volume) ─────────────────────────────────────────────────
export function Rings({ items }: { items: { label: string; v: number; c: string; ink?: string }[] }) {
  const max = Math.max(...items.map((i) => i.v), 1);
  return (
    <div className="rings">
      {items.map((it, i) => {
        const sz = 30 + (it.v / max) * 70;
        return (
          <div key={i} style={{
            position: "absolute", left: "50%", bottom: 0, transform: "translateX(-50%)",
            width: sz + "%", aspectRatio: "1/1", borderRadius: "50%",
            background: it.c, display: "flex", justifyContent: "center", paddingTop: 10,
            zIndex: items.length - i,
          }}>
            <span style={{ fontWeight: 800, fontSize: 13, color: it.ink || "var(--accent-deep)" }} className="num">{it.label}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Bars ─────────────────────────────────────────────────────────────────────
export function Bars({ data, color = "var(--accent)", height = 64 }: {
  data: (number | { v: number; label?: string; hot?: boolean })[]; color?: string; height?: number;
}) {
  const max = Math.max(...data.map((d) => (typeof d === "object" ? d.v : d)), 1);
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "flex-end", height, marginTop: 10 }}>
      {data.map((d, i) => {
        const v = typeof d === "object" ? d.v : d;
        const hot = typeof d === "object" && d.hot;
        return (
          <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
            <div style={{
              width: "100%", height: `${(v / max) * 100}%`, minHeight: 5,
              borderRadius: "4px 4px 0 0", background: hot ? color : "var(--line)", transition: "height .5s",
            }} />
            {typeof d === "object" && d.label && (
              <span style={{ fontSize: 9, color: "var(--ink-faint)", fontFamily: "var(--font-mono)" }}>{d.label}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Wave ─────────────────────────────────────────────────────────────────────
export function Wave({ n = 22, hotAt = 12, color = "var(--accent)" }: {
  n?: number; hotAt?: number; color?: string;
}) {
  const bars = Array.from({ length: n }, (_, i) => {
    const h = 20 + Math.abs(Math.sin(i * 0.9)) * 70 + Math.sin(i * 2.3) * 14;
    return Math.max(12, Math.min(96, h));
  });
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center", height: 70, marginTop: 14 }}>
      {bars.map((h, i) => (
        <div key={i} style={{
          flex: 1, height: h + "%", borderRadius: 99,
          background: i === hotAt ? color : "var(--line)",
        }} />
      ))}
    </div>
  );
}

// ── Donut ─────────────────────────────────────────────────────────────────────
export function Donut({ parts, size = 120 }: {
  parts: { v: number; c: string; on?: boolean }[]; size?: number;
}) {
  const R = 46, C = 2 * Math.PI * R;
  const tot = parts.reduce((s, p) => s + p.v, 0) || 1;
  let off = 0;
  const live = parts.filter((p) => p.on).length;
  return (
    <svg viewBox="0 0 120 120" width={size} height={size}>
      <circle cx="60" cy="60" r={R} fill="none" stroke="var(--line-soft)" strokeWidth="14" />
      {parts.map((p, i) => {
        const len = (p.v / tot) * C;
        const seg = (
          <circle key={i} cx="60" cy="60" r={R} fill="none" stroke={p.c} strokeWidth="14"
            strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-off}
            transform="rotate(-90 60 60)" strokeLinecap="round" />
        );
        off += len;
        return seg;
      })}
      <text x="60" y="56" textAnchor="middle" fontFamily="var(--font-mono)" fontSize="22" fontWeight="800" fill="var(--ink)">{live}</text>
      <text x="60" y="73" textAnchor="middle" fontFamily="var(--font-mono)" fontSize="8" fill="var(--ink-soft)" letterSpacing="1">LIVE</text>
    </svg>
  );
}
