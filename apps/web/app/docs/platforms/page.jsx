import { PLATFORMS } from "../../catalog";
import { Breadcrumbs, DocCards, DocHeader } from "../../components/docs/doc-parts";

export const metadata = { title: "Platforms", description: "The messaging platforms your Hermes agent can live in." };

export default function PlatformsIndex() {
  return <div className="doc-main wide">
    <Breadcrumbs items={[{ label: "Docs", href: "/docs" }, { label: "Platforms", href: "/docs/platforms" }]} />
    <DocHeader kicker={`${PLATFORMS.length} messaging platforms`} title="Platforms">
      <p>Talk to your agent where you already chat. Each platform skill runs a preflight before writing, enforces an allowlist of who can talk to your agent, and rolls back on failure. All of them come with every install.</p>
    </DocHeader>
    <DocCards entries={PLATFORMS.map((p) => ({ href: `/docs/platforms/${p.id}`, title: p.name, summary: p.summary, logo: p.logo }))} />
  </div>;
}
