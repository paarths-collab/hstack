/* ui.jsx — icons + shared UI primitives (exported to window) */

const ICONS = {
  menu: "M3 6h18M3 12h18M3 18h18",
  search: "M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3",
  mic: "M12 15a3 3 0 003-3V6a3 3 0 00-6 0v6a3 3 0 003 3zM19 11a7 7 0 01-14 0M12 18v3",
  plus: "M12 5v14M5 12h14",
  arrow: "M5 12h14M13 6l6 6-6 6",
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  radio: "M4.9 19.1a10 10 0 010-14.2M19.1 4.9a10 10 0 010 14.2M7.8 16.2a6 6 0 010-8.5M16.2 7.8a6 6 0 010 8.5M12 13a1 1 0 100-2 1 1 0 000 2z",
  clock: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  coins: "M9 14a6 6 0 100-12 6 6 0 000 12zM15 22a6 6 0 100-12M9 8h.01",
  info: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v5M12 8h.01",
  game: "M6 12h4M8 10v4M15 11h.01M18 13h.01M7 7h10a4 4 0 014 4v2a4 4 0 01-4 4c-1.5 0-2-1-3-2H10c-1 1-1.5 2-3 2a4 4 0 01-4-4v-2a4 4 0 014-4z",
  lock: "M6 11h12v9H6zM8 11V8a4 4 0 018 0v3",
  bell: "M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0",
  cal: "M3 6a2 2 0 012-2h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2zM3 10h18M8 2v4M16 2v4",
  share: "M18 8a3 3 0 10-2.8-4M6 15a3 3 0 100-6 3 3 0 000 6zM18 22a3 3 0 10-2.8-4M8.6 13.5l6.8 4M15.4 6.5l-6.8 4",
  terminal: "M4 5h16v14H4zM7 9l3 3-3 3M13 15h4",
  database: "M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3zM4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  mail: "M3 6h18v12H3zM3 7l9 6 9-6",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z",
  code: "M9 18l-6-6 6-6M15 6l6 6-6 6",
  cpu: "M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3M6 6h12v12H6zM10 10h4v4h-4z",
  bolt: "M13 2L4 14h7l-1 8 9-12h-7l1-8z",
  check: "M20 6L9 17l-5-5",
  refresh: "M3 12a9 9 0 019-9 9 9 0 016.7 3M21 3v6h-6M21 12a9 9 0 01-9 9 9 9 0 01-6.7-3M3 21v-6h6",
};

function Icon({ name, size = 18, sw = 2, ...rest }) {
  const d = ICONS[name] || ICONS.info;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      {d.split("M").filter(Boolean).map((seg, i) => <path key={i} d={"M" + seg} />)}
    </svg>
  );
}

function Card({ span = 12, rows, className = "", style = {}, delay, children }) {
  const s = { gridColumn: `span ${span}`, ...style };
  if (rows) s.gridRow = `span ${rows}`;
  if (delay != null) s.animationDelay = delay + "s";
  return <div className={`card ${delay != null ? "reveal" : ""} ${className}`} style={s}>{children}</div>;
}

function K({ children }) { return <div className="k">{children}</div>; }

function Meter({ pct, color, label, value }) {
  const col = color || (pct > 90 ? "var(--bad)" : pct > 72 ? "var(--warn)" : "var(--ok)");
  return (
    <div style={{ marginBottom: 13 }}>
      <div className="between" style={{ fontSize: 13 }}>
        <span style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{label}</span>
        <span className="num" style={{ color: "var(--ink-soft)" }}>{value != null ? value : pct + "%"}</span>
      </div>
      <div className="meter"><span style={{ width: pct + "%", background: col }} /></div>
    </div>
  );
}

function StatePill({ online }) {
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

const PLAT_COLOR = { Telegram: "#229ED9", Discord: "#5865F2", WhatsApp: "#25D366", Slack: "#611f69", Signal: "#3A76F0", agent: "var(--accent)" };
const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : Math.round(n));

Object.assign(window, { Icon, Card, K, Meter, StatePill, PLAT_COLOR, fmt });
