import { CORE_SKILLS } from "../../catalog";
import { Breadcrumbs, DocCards, DocHeader } from "../../components/docs/doc-parts";

export const metadata = { title: "Core skills", description: "Install Hermes and keep it healthy." };

export default function CoreIndex() {
  return <div className="doc-main wide">
    <Breadcrumbs items={[{ label: "Docs", href: "/docs" }, { label: "Core skills", href: "/docs/core" }]} />
    <DocHeader kicker={`${CORE_SKILLS.length} skills · in every install`} title="Core skills">
      <p>Deploy, run and repair. These install Hermes, set its model, personality and memory, and keep the gateway healthy. Platforms and integrations build on them.</p>
    </DocHeader>
    <DocCards entries={CORE_SKILLS.map((s) => ({ href: `/docs/core/${s.name}`, title: s.title, summary: s.copy }))} />
  </div>;
}
