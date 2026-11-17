import { notFound } from "next/navigation";
import { TIERS } from "../../../../catalog";
import { SkillDoc, skillMetadata } from "../../../../components/docs/skill-doc";

export const dynamicParams = false;

// Both segments are generated here: a parent [tier]/page.jsx does not pass its params down.
export function generateStaticParams() {
  return TIERS.flatMap((t) => t.items.map((i) => ({ tier: t.id, id: i.id })));
}

export async function generateMetadata({ params }) {
  const { id } = await params;
  return skillMetadata(`integration-${id}`);
}

export default async function IntegrationPage({ params }) {
  const { tier, id } = await params;
  const t = TIERS.find((x) => x.id === tier);
  if (!t || !t.items.some((i) => i.id === id)) notFound();
  return <SkillDoc skill={`integration-${id}`} />;
}
