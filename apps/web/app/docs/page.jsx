import Link from "next/link";
import { CORE_SKILLS, HERMES_VERSION, INTEGRATION_COUNT, PLATFORMS, SKILL_COUNT, TIERS } from "../catalog";
import { Icon } from "../components/ui-icons";
import { InstallCommand } from "../components/install-command";
import { DocHeader } from "../components/docs/doc-parts";
import { FadeIn } from "../components/scroll-reveal";

export const metadata = { title: { absolute: "Docs | hstack" }, description: `Guides to ${SKILL_COUNT} skills for self-hosted Hermes.` };

const sections = [
  { href: "/docs/how-it-works", icon: "workflow", title: "How it works", copy: "Understand the checks, install process, and recovery steps." },
  { href: "/docs/core", icon: "terminal", title: "Core skills", copy: "Install, configure, and maintain your Hermes agent.", count: CORE_SKILLS.length },
  { href: "/docs/platforms", icon: "globe", title: "Platforms", copy: "Bring your agent to the messaging apps you use.", count: PLATFORMS.length },
  { href: "/docs/integrations", icon: "layers", title: "Integrations", copy: `Connect your tools, organized into ${TIERS.length} tiers.`, count: INTEGRATION_COUNT },
];
const popular = ["notion", "github", "supabase", "stripe", "google-workspace", "linear"];
const popularEntries = TIERS.flatMap(t => t.items.map(item => ({ ...item, tier: t.id }))).filter(item => popular.includes(item.id));

export default function DocsHome() {
  return <div className="doc-main wide">
    <DocHeader kicker={`Documentation · Hermes v${HERMES_VERSION}`} title="HSTACK docs">
      <p>Everything you need to run Hermes on your own server. Find a skill, read the guide, and let your coding agent handle the setup.</p>
    </DocHeader>

    <section className="docs-start" aria-labelledby="first-setup">
      <div>
        <p className="doc-kicker">Start here</p>
        <h2 id="first-setup">Your first Hermes setup</h2>
        <p>Install the skills on the machine where your coding agent runs. Then tell it what you want to connect.</p>
        <Link className="docs-inline-link" href="/docs/core/hermes-deploy">Follow the deployment guide <Icon size={15} /></Link>
      </div>
      <div className="docs-start-command">
        <InstallCommand label="Install the skills" />
        <p>Already installed? <Link href="/docs/integrations">Find your next integration →</Link></p>
      </div>
    </section>

    <div className="docs-section-heading"><h2 className="docs-subhead">Explore the docs</h2><span>{SKILL_COUNT} guides to explore</span></div>
    <ul className="docs-sections">
      {sections.map((s, index) => <FadeIn as="li" key={s.href} index={index}>
        <Link href={s.href}>
          <span className="docs-section-icon"><Icon name={s.icon} size={20} /></span>
          <strong>{s.title}{s.count ? <small>{s.count}</small> : null}</strong>
          <span>{s.copy}</span>
          <em>Read guide <Icon size={14} /></em>
        </Link>
      </FadeIn>)}
    </ul>

    <div className="docs-section-heading"><h2 className="docs-subhead">Popular integrations</h2><Link className="docs-inline-link" href="/docs/integrations">View all {INTEGRATION_COUNT} <Icon size={14} /></Link></div>
    <ul className="logo-strip">
      {popularEntries.map(item => <li key={item.id}><Link href={`/docs/integrations/${item.tier}/${item.id}`}><img src={item.logo} alt="" width="24" height="24" /><span>{item.name}</span></Link></li>)}
    </ul>
    <p className="docs-source-note">New to Hermes? <Link className="docs-inline-link" href="/docs/core/hermes-deploy">Start with your first deployment →</Link></p>
  </div>;
}
