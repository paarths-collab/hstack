"use client";
import * as React from "react";
import { readAll, probeCapabilities, DEMO, type Bundle } from "@/lib/hermes";
import { StatePill } from "@/components/dashboard/charts";
import { Overview } from "@/components/dashboard/Overview";
import { Channels, Schedule, Ledger, Usage, About } from "@/components/dashboard/sections";
import { Visualize } from "@/components/office/Office";

/* ── icon primitives ───────────────────────────────────────────────────────── */
const ICONS: Record<string, string> = {
  menu: "M3 6h18M3 12h18M3 18h18",
  search: "M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3",
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  radio: "M4.9 19.1a10 10 0 010-14.2M19.1 4.9a10 10 0 010 14.2M7.8 16.2a6 6 0 010-8.5M16.2 7.8a6 6 0 010 8.5M12 13a1 1 0 100-2 1 1 0 000 2z",
  clock: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  coins: "M9 14a6 6 0 100-12 6 6 0 000 12zM15 22a6 6 0 100-12M9 8h.01",
  game: "M6 12h4M8 10v4M15 11h.01M18 13h.01M7 7h10a4 4 0 014 4v2a4 4 0 01-4 4c-1.5 0-2-1-3-2H10c-1 1-1.5 2-3 2a4 4 0 01-4-4v-2a4 4 0 014-4z",
  info: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v5M12 8h.01",
  lock: "M6 11h12v9H6zM8 11V8a4 4 0 018 0v3",
  bolt: "M13 2L4 14h7l-1 8 9-12h-7l1-8z",
};
function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const d = ICONS[name] || ICONS.info;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      {d.split("M").filter(Boolean).map((seg, i) => <path key={i} d={"M" + seg} />)}
    </svg>
  );
}

/* ── nav config ─────────────────────────────────────────────────────────────── */
const NAV = [
  { id: "overview", label: "Overview", icon: "grid" },
  { id: "channels", label: "Channels", icon: "radio" },
  { id: "schedule", label: "Schedule", icon: "clock" },
  { id: "ledger", label: "Activity Ledger", icon: "list" },
  { id: "usage", label: "Usage & Cost", icon: "coins" },
  { id: "visualize", label: "Visualize", icon: "game" },
  { id: "about", label: "What is hstack?", icon: "info" },
];

/* ── main component ─────────────────────────────────────────────────────────── */
export default function DashboardPage() {
  const [data, setData] = React.useState<Bundle | null>(null);
  const [caps, setCaps] = React.useState<{ toolsets: string[] }>({ toolsets: DEMO.toolsets });
  const [page, setPage] = React.useState("overview");
  const [skin, setSkin] = React.useState<"normal" | "pixel">("normal");
  const [now, setNow] = React.useState("");
  const scrollRef = React.useRef<HTMLDivElement>(null);

  /* polling */
  React.useEffect(() => {
    let alive = true;
    const tick = async () => {
      const [b, c] = await Promise.all([readAll(), probeCapabilities()]);
      if (!alive) return;
      setData(b);
      if (c.toolsets.length) setCaps({ toolsets: c.toolsets });
    };
    tick();
    const id = setInterval(tick, 10000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  /* clock */
  React.useEffect(() => {
    const tick = () => setNow(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  /* pixel skin */
  React.useEffect(() => {
    document.documentElement.classList.toggle("pixel", skin === "pixel");
  }, [skin]);

  /* demo class */
  React.useEffect(() => {
    if (data) document.documentElement.classList.toggle("demo", !data.live);
  }, [data]);

  const go = (id: string) => {
    setPage(id);
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  if (!data) {
    return (
      <div style={{ display: "grid", placeItems: "center", height: "100vh", color: "var(--ink-soft)" }} className="mono">
        Connecting to agent…
      </div>
    );
  }

  const online = (data.status.gateway as { running?: boolean })?.running ?? true;

  const PAGES: Record<string, React.ReactNode> = {
    overview: <Overview data={data} caps={caps} onVisualize={() => go("visualize")} onNav={go} />,
    channels: <Channels data={data} />,
    schedule: <Schedule data={data} />,
    ledger: <Ledger data={data} />,
    usage: <Usage data={data} />,
    visualize: <Visualize data={data} caps={caps} agentCount={8} />,
    about: <About />,
  };

  return (
    <div className="shell">
      <div className="surface">
        {/* ── sidebar ── */}
        <aside className="side">
          <div className="brand">
            <div className="mark">A</div>
            <div className="bt">
              Atlas<small>hstack</small>
              <span style={{ fontSize: 11 }}>mission control</span>
            </div>
          </div>

          <div className="seg" style={{ margin: "10px 0 4px", alignSelf: "stretch" }}>
            <button className={skin === "normal" ? "on" : ""} onClick={() => setSkin("normal")}>Normal</button>
            <button className={skin === "pixel" ? "on" : ""} onClick={() => setSkin("pixel")}>◍ Pixel</button>
          </div>

          <nav className="nav">
            <div className="navlabel">Monitor</div>
            {NAV.map((n) => (
              <button key={n.id} className={page === n.id ? "active" : ""} onClick={() => go(n.id)}>
                <span className="gi"><Icon name={n.icon} size={18} /></span>
                {n.label}
              </button>
            ))}
          </nav>

          <div className="side-spacer" />

          <div className="side-card">
            <span className="lk"><Icon name="lock" size={13} /> Read-only</span>
            This page only <b>reads</b> your agent over a private tunnel — it can't change or restart it.
          </div>

          <div className="sponsor">
            <span className="coin">DC</span>
            <span>Sponsored by <b>Digital Crew</b> · MIT</span>
          </div>
        </aside>

        {/* ── main ── */}
        <div className="main">
          <div className="topbar">
            <div className="ham"><Icon name="menu" size={18} /></div>
            <StatePill online={online} />
            <span className="demo-flag">DEMO DATA</span>
            <span className="mono" style={{ fontSize: 12, color: "var(--ink-soft)" }}>Hermes v{data.status.version}</span>
            <div className="search" style={{ marginLeft: "auto" }}>
              <Icon name="search" size={16} />
              <input placeholder="Search activity…" onChange={(e) => { if (e.target.value) go("ledger"); }} />
            </div>
            <div className="who">
              <div className="nm" style={{ textAlign: "right" }}>Atlas<small>your agent · {online ? "online" : "offline"}</small></div>
              <div className="av">A</div>
            </div>
          </div>

          <div className="scroll" ref={scrollRef}>
            {PAGES[page]}
            <div className="foot">
              <div>
                Deploy: <span className="host"><Icon name="bolt" size={13} /> Hostinger — one-click</span> · other VPS supported
              </div>
              <div>
                Built by Paarth ·{" "}
                <b style={{ color: "var(--ink)" }}>
                  <a href="https://www.digitalcrew.tech/en" target="_blank" rel="noreferrer" style={{ color: "inherit", textDecoration: "none" }}>
                    Digital Crew
                  </a>
                </b>
                {" · "}{now}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
