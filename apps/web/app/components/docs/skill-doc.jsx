import Link from "next/link";
import { breadcrumbsFor, entryForSkill, githubBlob, neighbours } from "../../docs-nav";
import { HERMES_VERSION } from "../../catalog";
import { CORE_GUIDES, INTEGRATION_GUIDES, PLATFORM_GUIDES } from "../../guide-content";
import { CopyButton } from "../copy-button";
import { Icon } from "../ui-icons";
import { Breadcrumbs, PrevNext } from "./doc-parts";
import { ScrollReveal } from "../scroll-reveal";

export function SkillDoc({ skill }) {
  const entry = entryForSkill(skill);
  const guide = entry.group === "core" ? CORE_GUIDES[skill] : entry.group === "platforms" ? PLATFORM_GUIDES[entry.id] : INTEGRATION_GUIDES[entry.id];
  const { prev, next } = neighbours(skill);
  const isCore = entry.group === "core";
  const isPlanning = skill === "blueprint-saas-founder";
  const startsWithServer = ["hermes-install", "hermes-deploy", "setup-ssh-keys"].includes(skill);
  const request = isCore ? guide.example : `Connect ${entry.title} to my Hermes server. Help me choose the right account and permissions, and check that the connection works.`;
  const source = githubBlob(`skills/${skill}/SKILL.md`);
  const requirements = [
    {
      title: isPlanning ? "A goal for your agent" : startsWithServer ? "Your server" : "Your Hermes server",
      icon: "globe",
      detail: isPlanning ? "Choose the work you want to automate and the decisions you want to keep." : startsWithServer ? "A server you control, with access for your coding agent." : `Hermes v${HERMES_VERSION}, installed directly on your server using its default profile.`,
    },
    { title: isCore ? "For this task" : `${entry.title} access`, detail: guide.access, icon: "shield" },
    {
      title: "A coding agent",
      icon: "workflow",
      detail: isPlanning ? "Your usual coding agent can prepare the blueprint for you to review. You do not need to connect a server to make the plan." : <>Use the coding agent you normally work with. It needs <Link href="/docs/core/setup-ssh-keys">access to your server</Link> to follow the setup guide.</>,
    },
  ];

  return <div className="doc-main reader-guide">
    <Breadcrumbs items={breadcrumbsFor(entry)} />
    <ScrollReveal as="header" className="reader-hero" effect="fade">
      <p className="doc-kicker">{isCore ? "Core guide" : entry.group === "platforms" ? "Messaging platform" : entry.tierName}</p>
      <div className="reader-title">
        <span className="reader-logo">{entry.logo ? <img src={entry.logo} alt="" width="36" height="36" /> : <Icon name="workflow" size={28} />}</span>
        <h1>{entry.title}</h1>
      </div>
      <p className="reader-summary">{guide.summary}</p>
      <div className="reader-actions">
        <a className="button button-primary" href="#get-started">Get started <Icon size={15} /></a>
        <a className="reader-source" href={source} target="_blank" rel="noreferrer">Instructions for your coding agent <Icon name="diagonal" size={13} /></a>
      </div>
    </ScrollReveal>

    <nav className="reader-section-nav" aria-label="Guide sections">
      <a href="#what-it-does">Overview</a><a href="#what-you-need">What you’ll need</a><a href="#get-started">Setup guide <Icon size={13} /></a>
    </nav>

    <section className="reader-section" aria-labelledby="what-it-does">
      <h2 id="what-it-does">What it does</h2>
      <p className="reader-purpose">{guide.example}</p>
      {guide.note ? <p className="reader-scope">{guide.note}</p> : null}
    </section>

    <section className="reader-section" aria-labelledby="what-you-need">
      <h2 id="what-you-need">What you’ll need</h2>
      <ul className="reader-requirements">
        {requirements.map(item => <li key={item.title}>
          <span className="reader-check"><Icon name={item.icon} size={19} /></span>
          <div><strong>{item.title}</strong><p>{item.detail}</p></div>
        </li>)}
      </ul>
    </section>

    <section className="reader-section" aria-labelledby="get-started">
      <h2 id="get-started">Get started</h2>
      <ol className="reader-setup">
        <li><span className="reader-step">1</span><div><h3>Install HSTACK</h3><p>Add the skills to the machine where your coding agent runs. <Link href="/docs/how-it-works#install">Follow the installation guide →</Link></p></div></li>
        <li><span className="reader-step">2</span><div><h3>Tell your agent what you want</h3><p>You can start with this request:</p><div className="reader-request"><div className="reader-request-top"><span>A starting point</span><CopyButton text={request} label="Copy request" className="button reader-copy"><Icon name="copy" size={14} /></CopyButton></div><p>{request}</p></div></div></li>
        <li><span className="reader-step">3</span><div><h3>{isCore ? "Review the result" : "Confirm the connection"}</h3><p>{isCore ? "Your agent follows the guide, checks the result, and tells you what changed or what needs your attention." : "Your agent checks the account and permissions before finishing. Follow any sign-in or pairing steps it asks you to complete, then confirm the connection with a small task."}</p></div></li>
      </ol>
    </section>

    <div className="reader-compatibility"><Icon name="shield" size={17} /><p>Designed for Hermes v{HERMES_VERSION}. These guides are checked against its source; live connection testing is still pending. <a href={githubBlob("compatibility/VALIDATION.md")} target="_blank" rel="noreferrer">Validation status ↗</a></p></div>
    <PrevNext prev={prev} next={next} />
  </div>;
}

export function skillMetadata(skill) {
  const entry = entryForSkill(skill);
  return entry ? { title: `${entry.title} · ${entry.group === "core" ? "Core guide" : entry.group === "platforms" ? "Platform" : entry.tierName}`, description: entry.summary } : {};
}
