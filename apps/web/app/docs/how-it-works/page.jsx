import Link from "next/link";
import { CODING_AGENTS, HERMES_VERSION } from "../../catalog";
import { githubBlob } from "../../docs-nav";
import { Breadcrumbs, DocHeader, PrevNext } from "../../components/docs/doc-parts";
import { InstallCommand } from "../../components/install-command";
import { Icon } from "../../components/ui-icons";

export const metadata = { title: "How it works", description: "Install HSTACK, choose your tools, and let your coding agent help you set up Hermes." };

export default function HowItWorks() {
  return <div className="doc-main reader-guide">
    <Breadcrumbs items={[{ label: "Docs", href: "/docs" }, { label: "How it works", href: "/docs/how-it-works" }]} />
    <DocHeader kicker="Getting started" title="How it works">
      <p>Choose what you want your agent to do. HSTACK gives your coding agent the guides to set it up on your own server.</p>
    </DocHeader>

    <section className="reader-section reader-install" aria-labelledby="install">
      <h2 id="install">1. Install the skills</h2>
      <p>Run the installer on the computer where your coding agent runs. It finds supported agents and adds the skills they need.</p>
      <InstallCommand label="Choose your operating system" />
      <p style={{ marginTop: 18 }}>Works with {CODING_AGENTS.map(agent => agent.name).join(", ")}. You can install everything or choose the tools you want during installation.</p>
    </section>

    <section className="reader-section" aria-labelledby="choose">
      <h2 id="choose">2. Choose your tools</h2>
      <p>Browse the <Link href="/docs/integrations">integrations</Link> and <Link href="/docs/platforms">messaging platforms</Link>. Each guide explains what it does and what you’ll need before you start.</p>
      <p>Starting from scratch? Follow <Link href="/docs/core/hermes-deploy">Deploy your agent</Link> to choose a model, a place to chat, and the other parts of your setup.</p>
    </section>

    <section className="reader-section" aria-labelledby="ask">
      <h2 id="ask">3. Ask your coding agent</h2>
      <p>Describe the outcome you want. Your coding agent follows the relevant guides and connects to your server to carry out the setup.</p>
      <div className="reader-request"><p>Set up Hermes on my server, connect Notion, and let me talk to it through Telegram.</p></div>
      <p>Your agent will tell you when you need to sign in, provide account access, or scan a pairing code. Only connect accounts and give permissions you want it to use.</p>
    </section>

    <section className="reader-section" aria-labelledby="check">
      <h2 id="check">4. Check the result</h2>
      <p>The guide includes checks before setup and a check of the finished connection. Your agent should tell you what worked, what changed, and anything that still needs attention.</p>
      <p>If a connection setup fails after settings have changed, the integration guide restores its previous settings. For an existing problem, start with <Link href="/docs/core/hermes-status">Check your agent</Link> or <Link href="/docs/core/hermes-fix">Fix a problem</Link>.</p>
    </section>

    <div className="reader-compatibility"><Icon name="shield" size={17} /><p>Designed for Hermes v{HERMES_VERSION}. Live server and vendor connection testing is still pending. <a href={githubBlob("compatibility/VALIDATION.md")} target="_blank" rel="noreferrer">Validation status ↗</a></p></div>
    <PrevNext prev={{ href: "/docs", title: "Overview" }} next={{ href: "/docs/core", title: "Core guides" }} />
  </div>;
}
