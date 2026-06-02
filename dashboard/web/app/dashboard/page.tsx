"use client";
import * as React from "react";
import Link from "next/link";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Visualize } from "@/components/office/Office";
import { readAll, probeCapabilities, type Bundle } from "@/lib/hermes";
import { ArrowLeft } from "lucide-react";

export default function DashboardPage() {
  const [data, setData] = React.useState<Bundle | null>(null);
  const [caps, setCaps] = React.useState<{ toolsets: string[] }>({ toolsets: [] });

  React.useEffect(() => {
    let alive = true;
    const tick = async () => {
      const [b, c] = await Promise.all([readAll(), probeCapabilities()]);
      if (!alive) return;
      setData(b); setCaps({ toolsets: c.toolsets });
    };
    tick();
    const id = setInterval(tick, 10000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (!data) return <div className="p-10 text-sm text-muted-foreground">Loading…</div>;

  const s = data.status;
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto max-w-7xl px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button asChild variant="ghost" size="sm"><Link href="/setup"><ArrowLeft className="h-4 w-4 mr-1" /> Setup</Link></Button>
            <div className="text-lg font-semibold tracking-tight">hstack · dashboard</div>
            <span className="mono text-xs text-muted-foreground">{data.live ? "● LIVE" : "● DEMO"}</span>
          </div>
          <div className="mono text-xs text-muted-foreground">v{s.version ?? "0.15.2"} · {s.sessions?.active ?? 0} active</div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        <Tabs defaultValue="visualize">
          <TabsList>
            <TabsTrigger value="visualize">Visualize</TabsTrigger>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="sessions">Sessions</TabsTrigger>
            <TabsTrigger value="cron">Cron</TabsTrigger>
          </TabsList>

          <TabsContent value="visualize" className="pt-6">
            <Visualize data={data} caps={caps} agentCount={8} />
          </TabsContent>

          <TabsContent value="overview" className="pt-6">
            <div className="grid gap-4 md:grid-cols-3">
              <Card><CardHeader><CardDescription>CPU</CardDescription><CardTitle className="num">{s.health?.cpu ?? "—"}%</CardTitle></CardHeader></Card>
              <Card><CardHeader><CardDescription>Memory</CardDescription><CardTitle className="num">{s.health?.mem ?? "—"}%</CardTitle></CardHeader></Card>
              <Card><CardHeader><CardDescription>Disk</CardDescription><CardTitle className="num">{s.health?.disk ?? "—"}%</CardTitle></CardHeader></Card>
            </div>
            <Card className="mt-4">
              <CardHeader><CardTitle className="text-lg">Platforms</CardTitle></CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {(s.platforms ?? []).map((p) => (
                  <span key={p.name} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${p.connected ? "bg-emerald-50 border-emerald-200" : "text-muted-foreground"}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${p.connected ? "bg-emerald-500" : "bg-zinc-300"}`} />{p.name}
                  </span>
                ))}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="sessions" className="pt-6">
            <Card><CardHeader><CardTitle className="text-lg">Recent sessions</CardTitle></CardHeader>
              <CardContent>
                <div className="divide-y">
                  {data.sessions.map((sn) => (
                    <div key={sn.id} className="py-3 flex items-center justify-between gap-4">
                      <div className="min-w-0">
                        <div className="text-sm truncate">{sn.summary}</div>
                        <div className="mono text-xs text-muted-foreground">{sn.platform} · {sn.tool} · {sn.updated}</div>
                      </div>
                      <div className="mono text-xs text-muted-foreground tabular-nums">{sn.tokens?.toLocaleString()} tok</div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="cron" className="pt-6">
            <Card><CardHeader><CardTitle className="text-lg">Scheduled jobs</CardTitle></CardHeader>
              <CardContent>
                <div className="divide-y">
                  {data.cron.map((c) => (
                    <div key={c.id} className="py-3 flex items-center justify-between gap-4">
                      <div className="min-w-0"><div className="text-sm">{c.name}</div><div className="mono text-xs text-muted-foreground">{c.schedule} · next {c.next_run}</div></div>
                      <span className={`mono text-xs ${c.paused ? "text-amber-600" : "text-emerald-600"}`}>{c.paused ? "paused" : "active"}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
