import { notFound } from "next/navigation";
import { TIERS } from "../../../catalog";
import { Breadcrumbs, DocCards, DocHeader } from "../../../components/docs/doc-parts";

export const dynamicParams = false;

export function generateStaticParams() {
  return TIERS.map((t) => ({ tier: t.id }));
}

export async function generateMetadata({ params }) {
  const { tier } = await params;
  const t = TIERS.find((x) => x.id === tier);
  return t ? { title: `${t.name} integrations`, description: t.blurb } : {};
}

export default async function TierPage({ params }) {
  const { tier } = await params;
  const t = TIERS.find((x) => x.id === tier);
  if (!t) notFound();
  const index = TIERS.indexOf(t);
  return <div className="doc-main wide">
    <Breadcrumbs items={[{ label: "Docs", href: "/docs" }, { label: "Integrations", href: "/docs/integrations" }, { label: t.name, href: `/docs/integrations/${t.id}` }]} />
    <DocHeader kicker={`Tier ${index + 1} of ${TIERS.length} · ${t.items.length} ${t.items.length === 1 ? "integration" : "integrations"}`} title={t.name}>
      <p>{t.blurb} Choose an app to learn how it fits into your agent’s workflow.</p>
    </DocHeader>
    <DocCards entries={t.items.map((i) => ({ href: `/docs/integrations/${t.id}/${i.id}`, title: i.name, summary: i.summary, logo: i.logo }))} />
  </div>;
}
