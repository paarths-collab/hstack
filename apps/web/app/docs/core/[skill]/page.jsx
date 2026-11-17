import { notFound } from "next/navigation";
import { CORE_SKILLS } from "../../../catalog";
import { SkillDoc, skillMetadata } from "../../../components/docs/skill-doc";

export const dynamicParams = false;

export function generateStaticParams() {
  return CORE_SKILLS.map((s) => ({ skill: s.name }));
}

export async function generateMetadata({ params }) {
  const { skill } = await params;
  return skillMetadata(skill);
}

export default async function CoreSkillPage({ params }) {
  const { skill } = await params;
  if (!CORE_SKILLS.some((s) => s.name === skill)) notFound();
  return <SkillDoc skill={skill} />;
}
