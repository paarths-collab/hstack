import Link from "next/link";
import { SiteHeader } from "./components/site-header";
import { SiteFooter } from "./components/site-footer";
import { AsciiHero } from "./components/ascii-hero";
import { InstallCommand } from "./components/install-command";
import { CopyButton } from "./components/copy-button";
import { Icon } from "./components/ui-icons";
import { FadeIn, ScrollReveal } from "./components/scroll-reveal";
import { HorizontalFeatures } from "./components/horizontal-features";
import { CODING_AGENTS, CORE_SKILLS, HERMES_VERSION, INSTALL_COMMANDS, INTEGRATION_COUNT, PLATFORMS, SKILL_COUNT } from "./catalog";
import "./home.css";

const command = (id) => INSTALL_COMMANDS.find((item) => item.id === id)?.command ?? "";
const pickCommand = "curl -fsSL https://raw.githubusercontent.com/paarths-collab/hstack/main/install.sh | bash -s -- --tier=memory,database --include=notion";

const installCards = [
  { id: "unix", meta: "Bash 3.2+", title: "macOS & Linux", icon: "terminal", text: command("mac"), label: "Copy install command", note: "Opens an interactive picker when a terminal is attached." },
  { id: "windows", meta: "PowerShell 7", title: "Windows", icon: "code", text: command("windows"), label: "Copy PowerShell command", note: "Copies skills instead of symlinking them." },
  { id: "pick", meta: "Any shell", title: "Pick & choose", icon: "layers", text: pickCommand, label: "Copy tier example", note: "--tier, --include and --ide narrow what gets installed." },
];

const questions = [
  ["What is hstack?", `A catalog of ${SKILL_COUNT} Markdown skills. Your coding agent reads them and follows the steps over SSH to install, connect and maintain Hermes on your own server. There is no hstack service, daemon or account.`],
  ["Which Hermes version does it target?", `Hermes v${HERMES_VERSION} only. Every skill checks hermes --version first and stops if it doesn’t match. The skills are source-verified against that tag; live validation per integration is tracked in compatibility/VALIDATION.md.`],
  ["Where do my API keys go?", "Only to ~/.hermes/.env on your server, with chmod 600. They are sent over SSH stdin, never put in config.yaml, a URL, a local command line or the chat."],
  ["What if something breaks halfway?", "Each skill snapshots your .env and config.yaml just before its first write. Any later failure restores both byte for byte, so you are back where you started."],
  ["Can I install only some integrations?", "Yes. Use --tier=memory,database to pick tiers, --include=notion,stripe for single integrations, or --ide=claude,hermes to limit which coding agents get the skills. Run without flags for an interactive picker."],
  ["Does hstack re-implement chat models?", "No. Hermes already talks to OpenAI, Anthropic, Groq, Mistral and others natively; /hermes-model configures that. Integrations only add what Hermes doesn’t do itself."],
];

function Glyph() {
  return <span className="title-glyph" aria-hidden="true">✳</span>;
}

const featureDetails = {
  1: { example: "Connect my agent to Telegram and limit access to my account.", points: ["8 messaging platforms", "Control who can reach your agent", "Pick a home channel for updates"], href: "/docs/platforms", link: "Explore messaging platforms" },
  2: { example: "Help me deploy Hermes on my own server.", points: ["Run on a server you choose", "Connect securely over SSH", "Keep your configuration local"], href: "/docs/core/hermes-deploy", link: "Plan your first deployment" },
  3: { example: "Check my server and show me the plan before making changes.", points: ["Server and version checks", "Read-only access validation", "A plan to review before setup"], href: "/docs/how-it-works", link: "See how setup works" },
  4: { example: "Help me connect a tool without sharing my keys in chat.", points: ["Private credentials on your server", "Secrets kept out of app settings", "Only the permissions you approve"], href: "/docs/how-it-works", link: "Understand the setup process" },
  5: { example: "Check my agent’s health and help me recover if something failed.", points: ["Gateway readiness checks", "A live connection test", "Previous settings restored on failure"], href: "/docs/core/hermes-status", link: "Explore agent health checks" },
  6: { example: "Help me set up Hermes with a model, memory and personality.", points: ["Install and deploy", "Models, memory and personality", "Health checks, upgrades and repairs"], href: "/docs/core", link: "Explore all core guides" },
};

function Feature({ id, number, kicker, title, children, art, artLabel }) {
  const details = featureDetails[number];
  return <article className="feature" id={id}>
    <p className="feature-kicker">#{number} {kicker}</p>
    <h3>{title}</h3>
    <p className="feature-copy">{children}</p>
    <div className="feature-benefits">
      <p>What you get</p>
      <ul>{details.points.map(point => <li key={point}><Icon name="check" size={15} /><span>{point}</span></li>)}</ul>
    </div>
    <div className="feature-example"><span>Try asking</span><p>“{details.example}”</p></div>
    <Link className="feature-guide" href={details.href}><span>{details.link}</span><Icon name="arrow" size={17} /></Link>
    <div className="dither-tile feature-art" role="img" aria-label={artLabel}>{art}</div>
  </article>;
}

function Terminal({ lines }) {
  return <pre className="tile-terminal" aria-hidden="true">{lines.map(([mark, text], i) => <span key={i} className={`line line-${mark}`}><b>{mark === "ok" ? "✓" : mark === "bad" ? "✗" : mark === "cmd" ? "$" : "→"}</b>{text}{"\n"}</span>)}</pre>;
}

export default function HomePage() {
  return <div className="hermes-site">
    <a className="skip-link" href="#main">Skip to content</a>
    <SiteHeader />
    <main id="main">
      <section className="hero tone-blue" id="get-started" data-tone="blue">
        <div className="container hero-grid">
          <div className="hero-copy">
            <FadeIn as="h1">Hermes On<br />Your Own<br />Server</FadeIn>
            <FadeIn as="p" className="hero-lede" index={1}>Your agent, on your terms. Set up Hermes on your server and connect the tools you already use.</FadeIn>
            <div className="hero-actions">
              <a className="button button-primary" href="#install"><Icon name="download" size={16} />Install hstack</a>
              <Link className="button button-ghost" href="/docs/integrations"><Icon name="layers" size={16} />Browse integrations</Link>
            </div>
            <InstallCommand label="Install via terminal" />
          </div>
          <ScrollReveal className="hero-art" effect="fade" delay={140}><AsciiHero /></ScrollReveal>
        </div>
      </section>

      <section className="install tone-blue" id="install" data-tone="blue">
        <div className="container">
          <FadeIn className="section-title centered">
            <span className="title-icon" aria-hidden="true"><Icon name="terminal" size={22} /></span>
            <h2>Install hstack</h2>
            <p>{SKILL_COUNT} skills · {PLATFORMS.length} platforms · {INTEGRATION_COUNT} integrations · Hermes v{HERMES_VERSION}</p>
          </FadeIn>
          <div className="install-cards">
            {installCards.map((card, index) => <FadeIn as="article" className="dither-tile install-card" id={`install-${card.id}`} key={card.id} index={index}>
              <p className="install-meta">{card.meta}</p>
              <h3>{card.title}</h3>
              <CopyButton text={card.text} label={card.label}><Icon name={card.icon} size={15} /></CopyButton>
              <p className="install-note">{card.note}</p>
            </FadeIn>)}
          </div>
          <div className="agents-row" id="agents">
            <p className="agents-label">Auto-detects your coding agents</p>
            <ul>
              {CODING_AGENTS.map((agent) => <li key={agent.id}><img src={agent.logo} alt="" width="22" height="22" /><span><strong>{agent.name}</strong><code>{agent.dir}</code></span></li>)}
            </ul>
          </div>
        </div>
      </section>

      <section className="features tone-paper" id="features" data-tone="paper">
          <HorizontalFeatures heading={<h2>Features<Glyph /></h2>}>
            <Feature id="platforms" number={1} kicker="Connect" title="Lives Where You Chat" artLabel={`${PLATFORMS.length} messaging platforms`} art={<ul className="platform-grid">
              {PLATFORMS.map((p) => <li key={p.id}><Link className="platform-card" href={`/docs/platforms/${p.id}`} title={p.note}><span className="platform-logo"><img src={p.logo} alt="" width="26" height="26" /></span><span className="platform-name">{p.name}</span><code>/platform-{p.id}</code></Link></li>)}
            </ul>}>
              Telegram, Discord, Slack, WhatsApp, Signal, Teams, Google Chat and Mattermost. Each runs a preflight, enforces an allowlist of who can talk to your agent, and rolls back on failure.
            </Feature>
            <Feature number={2} kicker="Own" title="Your Server, Your Control" artLabel="Self-hosted Hermes server" art={<Terminal lines={[["cmd", "ssh your-server"], ["ok", "your infrastructure"], ["ok", "your private configuration"], ["ok", "your Hermes agent"]]} />}>
              Run Hermes on infrastructure you choose. Your agent’s configuration and private credentials stay on the server you control.
            </Feature>
            <Feature id="how-it-works" number={3} kicker="Check" title="Tested Before Writing" artLabel="Preflight transcript" art={<Terminal lines={[["cmd", "/integration-notion"], ["ok", "on the VPS host, not a container"], ["ok", `hermes --version  ${HERMES_VERSION}`], ["ok", "read-only vendor call  200"], ["go", "dry run, then write"]]} />}>
              Every skill confirms it is on the VPS host, checks the Hermes version, then calls the vendor’s API read-only with your key. A bad key aborts with nothing written.
            </Feature>
            <Feature number={4} kicker="Protect" title="Secrets Stay Private" artLabel="Secret storage" art={<Terminal lines={[["cmd", "ls -l ~/.hermes/.env"], ["ok", "-rw-------  root  .env"], ["cmd", "grep notion config.yaml"], ["go", "${NOTION_API_KEY}"]]} />}>
              Keys go to ~/.hermes/.env with chmod 600 over SSH stdin. config.yaml only holds {"${VAR}"} references. Nothing lands in a URL, argv or chat.
            </Feature>
            <Feature number={5} kicker="Verify" title="Prove It, or Roll Back" artLabel="Gateway check and rollback" art={<Terminal lines={[["cmd", "gateway ensure --json"], ["ok", "\"state\": \"ready\""], ["bad", "smoke test failed"], ["go", "rollback: .env and config restored"]]} />}>
              The gateway restarts and must report ready. A live smoke test runs through Hermes. Any failure restores your previous .env and config byte for byte.
            </Feature>
            <Feature number={6} kicker="Repair" title="Deploy, Run, Repair" artLabel="Core skills" art={<ul className="skill-cloud">
              {CORE_SKILLS.slice(0, 12).map((s) => <li key={s.name}>/{s.name}</li>)}
            </ul>}>
              {CORE_SKILLS.length} core skills install Hermes and keep it healthy: model, personality, memory, health checks, upgrades and repairs. Integrations build on these.
            </Feature>
          </HorizontalFeatures>
      </section>

      <section className="core tone-paper" id="core" data-tone="paper">
        <div className="container">
          <p className="table-caption">Core skills · Deploy, run, repair</p>
          <div className="core-table" role="table" aria-label="Core skills">
            <div role="row" className="core-row core-head"><span role="columnheader">Skill</span><span role="columnheader">What it does</span></div>
            {CORE_SKILLS.map((s) => <div role="row" className="core-row" key={s.name}><span role="cell"><Link href={`/docs/core/${s.name}`}><code>/{s.name}</code></Link></span><span role="cell">{s.copy}</span></div>)}
          </div>
          <p className="table-caption">Open source · Apache 2.0 · Targets Hermes v{HERMES_VERSION}</p>
        </div>
      </section>
      <section className="faq tone-paper" id="faq" data-tone="paper">
        <div className="container">
          <FadeIn className="section-title split"><h2>FAQs<Glyph /></h2><Link className="text-link" href="/docs">View docs</Link></FadeIn>
          <div className="faq-list">{questions.map(([question, answer]) => <details key={question}><summary><span>{question}</span><Icon name="plus" size={15} /></summary><p>{answer}</p></details>)}</div>
        </div>
      </section>

    </main>
    <SiteFooter />
  </div>;
}
