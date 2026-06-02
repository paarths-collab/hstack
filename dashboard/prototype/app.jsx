/* app.jsx — shell: sidebar nav, topbar, polling, pixel re-skin, tweaks, mount */

const NAV = [
  { id: "overview", label: "Overview", icon: "grid" },
  { id: "channels", label: "Channels", icon: "radio" },
  { id: "schedule", label: "Schedule", icon: "clock" },
  { id: "ledger", label: "Activity Ledger", icon: "list" },
  { id: "usage", label: "Usage & Cost", icon: "coins" },
  { id: "visualize", label: "Visualize", icon: "game" },
  { id: "about", label: "What is hstack?", icon: "info" },
];

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "skin": "normal",
  "accent": "#E2543A",
  "agents": 8,
  "reduceMotion": false
}/*EDITMODE-END*/;

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [page, setPage] = useState("overview");
  const [navHover, setNavHover] = useState(null);
  const [data, setData] = useState(null);
  const [caps, setCaps] = useState({ toolsets: window.HData.DEMO.capabilitiesProbe.toolsets });
  const [now, setNow] = useState(new Date());

  // poll status (read-only)
  useEffect(() => {
    let alive = true;
    async function tick() { const d = await window.HData.readAll(); if (alive) setData(d); }
    tick();
    const id = setInterval(tick, window.HData.CFG.POLL.status);
    window.HData.probeCapabilities().then((c) => { if (alive) setCaps(c); });
    return () => { alive = false; clearInterval(id); };
  }, []);

  useEffect(() => { const id = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(id); }, []);

  // apply skin + accent + demo flag to <body>
  useEffect(() => {
    document.body.classList.toggle("pixel", t.skin === "pixel");
    document.body.classList.toggle("reduce-motion", !!t.reduceMotion);
    document.body.style.setProperty("--accent", t.accent);
  }, [t.skin, t.accent, t.reduceMotion]);
  useEffect(() => { document.body.classList.toggle("demo", data ? !data.live : false); }, [data]);

  if (!data) return <div style={{ display: "grid", placeItems: "center", height: "100vh", color: "var(--ink-soft)" }} className="mono">Connecting to agent…</div>;

  const online = data.status.gateway?.running ?? true;
  const go = (id) => { setPage(id); document.querySelector(".scroll")?.scrollTo({ top: 0 }); };

  const PAGES = {
    overview: <Overview data={data} caps={caps} onVisualize={() => go("visualize")} onNav={go} />,
    channels: <Channels data={data} />,
    schedule: <Schedule data={data} />,
    ledger: <Ledger data={data} />,
    usage: <Usage data={data} />,
    visualize: <Visualize data={data} caps={caps} agentCount={t.agents} key={t.agents} />,
    about: <About />,
  };

  return (
    <div className="shell">
      <div className="surface">
        {/* sidebar */}
        <aside className="side">
          <div className="brand">
            <div className="mark">A</div>
            <div className="bt">Atlas<small>hstack</small><span style={{ fontSize: 11 }}>mission control</span></div>
          </div>
          <div className="seg" style={{ margin: "10px 6px 4px", alignSelf: "flex-start" }}>
            <button className={t.skin === "normal" ? "on" : ""} onClick={() => setTweak("skin", "normal")}>Normal</button>
            <button className={t.skin === "pixel" ? "on" : ""} onClick={() => setTweak("skin", "pixel")}>◍ Pixel</button>
          </div>
          <nav className="nav">
            <div className="navlabel">Monitor</div>
            {NAV.map((n) => {
              const on = page === n.id;
              const hov = navHover === n.id;
              return (
                <button key={n.id} className={on ? "active" : ""} onClick={() => go(n.id)}
                  onMouseEnter={() => setNavHover(n.id)} onMouseLeave={() => setNavHover((h) => (h === n.id ? null : h))}
                  style={{ background: on ? "var(--ink-dark)" : hov ? "var(--card)" : "transparent", color: on ? "#fff" : hov ? "var(--ink)" : "var(--ink-soft)" }}>
                  <span className="gi" style={{ color: on ? "var(--accent)" : "var(--ink-faint)" }}><Icon name={n.icon} size={18} /></span>{n.label}
                </button>
              );
            })}
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

        {/* main */}
        <div className="main">
          <div className="topbar">
            <div className="ham"><Icon name="menu" size={18} /></div>
            <StatePill online={online} />
            <span className="demo-flag">DEMO DATA</span>
            <span className="mono muted" style={{ fontSize: 12 }}>Hermes v{data.status.version}</span>
            <div className="search" style={{ marginLeft: "auto" }}>
              <Icon name="search" size={16} />
              <input placeholder="Search activity…" onChange={(e) => { if (e.target.value) go("ledger"); }} />
            </div>
            <div className="who">
              <div className="nm" style={{ textAlign: "right" }}>Atlas<small>your agent · {online ? "online" : "offline"}</small></div>
              <div className="av">A</div>
            </div>
          </div>

          <div className="scroll">
            {PAGES[page]}
            <div className="foot">
              <div>Deploy: <span className="host"><Icon name="bolt" size={13} /> Hostinger — one-click</span> · other VPS supported</div>
              <div>Built by Paarth · <b style={{ color: "var(--ink)" }}>Sponsored by Digital Crew</b> · {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Tweaks */}
      <TweaksPanel>
        <TweakSection label="Appearance" />
        <TweakRadio label="Skin" value={t.skin} options={["normal", "pixel"]} onChange={(v) => setTweak("skin", v)} />
        <TweakColor label="Accent" value={t.accent} options={["#E2543A", "#0F6B47", "#2A6FDB", "#B6892E"]} onChange={(v) => setTweak("accent", v)} />
        <TweakSection label="Pixel office" />
        <TweakSlider label="Agents" value={t.agents} min={1} max={8} onChange={(v) => setTweak("agents", v)} />
        <TweakToggle label="Reduce motion" value={t.reduceMotion} onChange={(v) => setTweak("reduceMotion", v)} />
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
