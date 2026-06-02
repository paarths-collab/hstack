"use client";
import * as React from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { readAll, probeCapabilities, DEMO, type Bundle } from "@/lib/hermes";
import { Overview, Channels, Schedule, Ledger, Usage, About } from "@/components/dashboard/sections";
import { Visualize } from "@/components/office/Office";

const TABS = [
  { id: "overview", label: "Overview" }, { id: "channels", label: "Channels" }, { id: "schedule", label: "Schedule" },
  { id: "ledger", label: "Activity Ledger" }, { id: "usage", label: "Usage & Cost" }, { id: "visualize", label: "Visualize" }, { id: "about", label: "What is hstack?" },
];

export default function Page() {
  const [data, setData] = React.useState<Bundle | null>(null);
  const [caps, setCaps] = React.useState<{ toolsets: string[] }>({ toolsets: DEMO.toolsets });
  const [pixel, setPixel] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    const tick = async () => { const d = await readAll(); if (alive) setData(d); };
    tick();
    const id = setInterval(tick, 5000); // poll /api/status cadence (read-only)
    probeCapabilities().then((c) => alive && setCaps({ toolsets: c.toolsets }));
    return () => { alive = false; clearInterval(id); };
  }, []);

  React.useEffect(() => { document.documentElement.classList.toggle("pixel", pixel); }, [pixel]);

  if (!data) return <div className="grid place-items-center h-screen text-[var(--ink-soft)] mono">Connecting to agent…</div>;
  const online = typeof data.status.gateway === "object" ? data.status.gateway?.running ?? true : true;

  return (
    <div className="min-h-screen p-3 md:p-4">
      <div className="bg-[var(--panel)] rounded-[34px] overflow-hidden min-h-[calc(100vh-32px)] shadow-[0_24px_60px_-30px_rgba(40,33,22,.35)]">
        {/* topbar */}
        <header className="flex items-center gap-4 px-7 py-4 border-b border-[var(--line)]">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-[14px] grid place-items-center font-extrabold text-white" style={{ background: "var(--ink-dark)" }}>A</div>
            <div className="font-extrabold text-[17px] leading-none">Atlas<div className="num text-[9px] tracking-[.22em] text-[var(--accent)] uppercase mt-1">hstack</div></div>
          </div>
          <span className="ml-3 inline-flex items-center gap-2 text-[13px] font-extrabold px-3 py-1.5 rounded-full" style={{ background: online ? "var(--ok-soft)" : "var(--accent-soft)", color: online ? "var(--ok)" : "var(--accent-deep)" }}>
            <span className="w-2 h-2 rounded-full" style={{ background: online ? "var(--ok)" : "var(--accent-deep)" }} />{online ? "Online" : "Offline"}
          </span>
          {!data.live && <span className="num text-[10px] font-extrabold px-2 py-1 rounded" style={{ background: "var(--warn)", color: "#241a02" }}>DEMO DATA</span>}
          <span className="num text-[12px] text-[var(--ink-soft)]">Hermes v{data.status.version}</span>
          <div className="ml-auto flex items-center gap-3">
            <Button variant="outline" size="sm" onClick={() => setPixel((p) => !p)}>{pixel ? "Normal" : "◍ Pixel"}</Button>
          </div>
        </header>

        <div className="p-6 md:p-7">
          <Tabs defaultValue="overview">
            <TabsList className="flex-wrap gap-1 mb-5">
              {TABS.map((t) => <TabsTrigger key={t.id} value={t.id}>{t.label}</TabsTrigger>)}
            </TabsList>
            <TabsContent value="overview"><Overview data={data} /></TabsContent>
            <TabsContent value="channels"><Channels data={data} /></TabsContent>
            <TabsContent value="schedule"><Schedule data={data} /></TabsContent>
            <TabsContent value="ledger"><Ledger data={data} /></TabsContent>
            <TabsContent value="usage"><Usage data={data} /></TabsContent>
            <TabsContent value="visualize"><Visualize data={data} caps={caps} agentCount={8} /></TabsContent>
            <TabsContent value="about"><About /></TabsContent>
          </Tabs>
          <footer className="mt-8 pt-5 border-t border-[var(--line)] flex flex-wrap gap-3 justify-between text-[12.5px] text-[var(--ink-soft)]">
            <span>Read-only · GET requests only · reach :9119 over an SSH tunnel.</span>
            <span>Built by Paarth · <b className="text-[var(--ink)]">Sponsored by Digital Crew</b> · MIT</span>
          </footer>
        </div>
      </div>
    </div>
  );
}
