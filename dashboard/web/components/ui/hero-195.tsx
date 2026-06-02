"use client";
import * as React from "react";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BorderBeam } from "@/components/ui/border-beam";
import { Terminal, Copy, Check, ArrowRight, Zap, Shield, Cpu } from "lucide-react";

function CopyBlock({ code, lang = "bash" }: { code: string; lang?: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <div className="relative group">
      <pre className="overflow-x-auto rounded-md border bg-muted/40 px-4 py-3 text-[13px] leading-relaxed mono">
        <code>{code}</code>
      </pre>
      <button
        onClick={() => { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1400); }}
        className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-md border bg-background opacity-0 transition group-hover:opacity-100"
        aria-label={`Copy ${lang} command`}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

export function Hero195() {
  return (
    <section className="relative min-h-screen w-full overflow-hidden bg-background text-foreground">
      <div className="absolute inset-0 -z-10 [background:radial-gradient(ellipse_at_top,theme(colors.zinc.100),transparent_60%)]" />
      <div className="mx-auto max-w-6xl px-6 py-16 md:py-24">
        <div className="flex flex-col items-center text-center gap-4">
          <div className="inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground mono">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> hstack · v0.15.2 verified
          </div>
          <h1 className="text-4xl md:text-6xl font-semibold tracking-tight max-w-3xl">
            Self-host Hermes Agent in one command.
          </h1>
          <p className="max-w-2xl text-muted-foreground text-base md:text-lg">
            A vetted toolkit that installs Hermes, wires up your providers, and gives you a live dashboard — no telemetry, your VPS.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
            <Button asChild size="lg"><Link href="/dashboard">Open dashboard <ArrowRight className="ml-1.5 h-4 w-4" /></Link></Button>
            <Button asChild size="lg" variant="outline"><a href="https://github.com/paarths-collab/hstack" target="_blank" rel="noreferrer">View on GitHub</a></Button>
          </div>
        </div>

        <Card className="relative mt-12 overflow-hidden">
          <BorderBeam size={260} duration={12} colorFrom="#E2543A" colorTo="#9c40ff" />
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Terminal className="h-4 w-4" /> Install Hermes</div>
            <CardTitle>Pick your platform</CardTitle>
            <CardDescription>Native installers from Nous Research. Both finish with <code className="mono text-foreground">hermes setup</code> to walk through providers.</CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="mac" className="w-full">
              <TabsList className="grid w-full grid-cols-3 max-w-md">
                <TabsTrigger value="mac">macOS / Linux</TabsTrigger>
                <TabsTrigger value="win">Windows</TabsTrigger>
                <TabsTrigger value="docker">Docker</TabsTrigger>
              </TabsList>
              <TabsContent value="mac" className="space-y-3 pt-3">
                <Label className="text-xs text-muted-foreground">1. Install</Label>
                <CopyBlock code={`curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash`} />
                <Label className="text-xs text-muted-foreground">2. Configure</Label>
                <CopyBlock code={`hermes setup`} />
              </TabsContent>
              <TabsContent value="win" className="space-y-3 pt-3">
                <Label className="text-xs text-muted-foreground">1. Install (PowerShell)</Label>
                <CopyBlock code={`irm https://hermes-agent.nousresearch.com/install.ps1 | iex`} lang="powershell" />
                <Label className="text-xs text-muted-foreground">2. Configure</Label>
                <CopyBlock code={`hermes setup`} lang="powershell" />
              </TabsContent>
              <TabsContent value="docker" className="space-y-3 pt-3">
                <Label className="text-xs text-muted-foreground">Pull + run</Label>
                <CopyBlock code={`docker run -d --name hermes -p 9119:9119 -v ~/.hermes:/root/.hermes ghcr.io/nousresearch/hermes-agent:0.15.2`} />
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        <div className="mt-8 grid gap-5 md:grid-cols-3">
          <Card>
            <CardHeader>
              <Zap className="h-5 w-5 text-amber-500" />
              <CardTitle className="text-lg">One command</CardTitle>
              <CardDescription>From bare VPS to running agent in under five minutes. The Claude Code skill does the rest.</CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <Shield className="h-5 w-5 text-emerald-500" />
              <CardTitle className="text-lg">No telemetry</CardTitle>
              <CardDescription>Install metrics come from your repo's own GitHub clone counter — never from your agent.</CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <Cpu className="h-5 w-5 text-violet-500" />
              <CardTitle className="text-lg">Self-improving</CardTitle>
              <CardDescription>Add a tool or MCP server and a new room appears in the office — automatically.</CardDescription>
            </CardHeader>
          </Card>
        </div>

        <Card className="mt-8">
          <CardHeader>
            <CardTitle className="text-lg">Quick provider key (optional)</CardTitle>
            <CardDescription>Paste once now to skip the wizard. Stored at <code className="mono text-foreground">~/.hermes/.env</code> (chmod 600).</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-[1fr_auto] items-end">
            <div className="grid gap-2">
              <Label htmlFor="key">OpenRouter API key</Label>
              <Input id="key" placeholder="sk-or-v1-…" type="password" />
            </div>
            <Button variant="secondary" disabled className="w-full md:w-auto">Save (use <span className="mono mx-1">hermes config set</span> on the host)</Button>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
