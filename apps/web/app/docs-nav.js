// Docs navigation built from the catalog. Shared by server pages and the client sidebar (no filesystem access here).
import { CORE_SKILLS, PLATFORMS, TIERS } from "./catalog.js";

export const GITHUB = "https://github.com/paarths-collab/hstack";
export const githubBlob = (repoPath) => `${GITHUB}/blob/main/${repoPath}`;

const coreEntries = CORE_SKILLS.map((s) => ({
  skill: s.name,
  title: s.title,
  summary: s.copy,
  href: `/docs/core/${s.name}`,
  group: "core",
  logo: null,
}));

const platformEntries = PLATFORMS.map((p) => ({
  skill: `platform-${p.id}`,
  id: p.id,
  title: p.name,
  summary: p.summary,
  href: `/docs/platforms/${p.id}`,
  group: "platforms",
  logo: p.logo,
}));

const integrationEntries = TIERS.flatMap((t) => t.items.map((i) => ({
  skill: i.skill,
  id: i.id,
  title: i.name,
  summary: i.summary,
  href: `/docs/integrations/${t.id}/${i.id}`,
  group: "integrations",
  tier: t.id,
  tierName: t.name,
  logo: i.logo,
})));

// Reading order for previous / next links.
export const SKILL_ENTRIES = [...coreEntries, ...platformEntries, ...integrationEntries];
const bySkill = new Map(SKILL_ENTRIES.map((e) => [e.skill, e]));

export function entryForSkill(skill) {
  return bySkill.get(skill) ?? null;
}

export function neighbours(skill) {
  const i = SKILL_ENTRIES.findIndex((e) => e.skill === skill);
  return { prev: i > 0 ? SKILL_ENTRIES[i - 1] : null, next: i >= 0 && i < SKILL_ENTRIES.length - 1 ? SKILL_ENTRIES[i + 1] : null };
}

export function breadcrumbsFor(entry) {
  const crumbs = [{ label: "Docs", href: "/docs" }];
  if (entry.group === "core") crumbs.push({ label: "Core skills", href: "/docs/core" });
  if (entry.group === "platforms") crumbs.push({ label: "Platforms", href: "/docs/platforms" });
  if (entry.group === "integrations") {
    crumbs.push({ label: "Integrations", href: "/docs/integrations" });
    crumbs.push({ label: entry.tierName, href: `/docs/integrations/${entry.tier}` });
  }
  crumbs.push({ label: entry.title, href: entry.href });
  return crumbs;
}

// Sidebar tree. Integrations nest one level deeper, by tier.
export const DOCS_NAV = [
  { id: "start", title: "Start here", items: [
    { title: "Overview", href: "/docs" },
    { title: "How it works", href: "/docs/how-it-works" },
  ] },
  { id: "core", title: "Core skills", href: "/docs/core", items: coreEntries.map(({ title, href }) => ({ title, href })) },
  { id: "platforms", title: "Platforms", href: "/docs/platforms", items: platformEntries.map(({ title, href, logo }) => ({ title, href, logo })) },
  { id: "integrations", title: "Integrations", href: "/docs/integrations", tiers: TIERS.map((t) => ({
    id: t.id,
    title: t.name,
    href: `/docs/integrations/${t.id}`,
    items: t.items.map((i) => ({ title: i.name, href: `/docs/integrations/${t.id}/${i.id}`, logo: i.logo })),
  })) },
];
