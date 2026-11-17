import { notFound } from "next/navigation";
import { PLATFORMS } from "../../../catalog";
import { SkillDoc, skillMetadata } from "../../../components/docs/skill-doc";

export const dynamicParams = false;

export function generateStaticParams() {
  return PLATFORMS.map((p) => ({ id: p.id }));
}

export async function generateMetadata({ params }) {
  const { id } = await params;
  return skillMetadata(`platform-${id}`);
}

export default async function PlatformPage({ params }) {
  const { id } = await params;
  if (!PLATFORMS.some((p) => p.id === id)) notFound();
  return <SkillDoc skill={`platform-${id}`} />;
}
