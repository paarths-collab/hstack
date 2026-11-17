"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { DOCS_NAV } from "../../docs-nav";
import { SKILL_COUNT } from "../../catalog";
import { Icon } from "../ui-icons";

function NavLink({ item, pathname }) {
  const active = pathname === item.href;
  return <li>
    <Link href={item.href} className={active ? "is-active" : undefined} aria-current={active ? "page" : undefined}>
      {item.logo ? <img src={item.logo} alt="" width="16" height="16" /> : null}
      <span>{item.title}</span>
    </Link>
  </li>;
}

export function DocsSidebar() {
  const pathname = (usePathname() || "/docs").replace(/\/$/, "") || "/docs";
  const [filter, setFilter] = useState("");
  const q = filter.trim().toLowerCase();
  const match = title => !q || title.toLowerCase().includes(q);
  const within = href => pathname === href || pathname.startsWith(`${href}/`);
  const groups = DOCS_NAV.map(g => g.tiers
    ? { ...g, tiers: g.tiers.map(t => ({ ...t, items: t.items.filter(i => match(i.title) || match(t.title)) })).filter(t => t.items.length) }
    : { ...g, items: g.items.filter(i => match(i.title)) }
  ).filter(g => g.tiers ? g.tiers.length : g.items.length);

  function closeMobileNavigation(event) {
    if (event.target.closest("a")) {
      const drawer = event.currentTarget.closest(".docs-sidebar-mobile");
      if (drawer) drawer.open = false;
    }
  }

  return <nav className="docs-sidebar" aria-label="Docs" onClick={closeMobileNavigation}>
    <label className="docs-filter">
      <span className="visually-hidden">Filter docs</span>
      <Icon name="search" size={16} />
      <input type="search" placeholder="Find a guide…" value={filter} onChange={e => setFilter(e.target.value)} />
    </label>
    {!groups.length ? <p className="docs-no-results" role="status">No skills found. Try an app or skill name.</p> : null}
    {groups.map(g => {
      const items = g.items ? <ul>{g.items.map(item => <NavLink key={item.href} item={item} pathname={pathname} />)}</ul> : null;
      if (!g.href) return <section key={g.id} className="docs-nav-group"><p className="docs-nav-title">{g.title}</p>{items}</section>;
      return <details key={`${g.id}-${Boolean(q)}-${within(g.href)}`} className="docs-nav-group" open={Boolean(q) || within(g.href) || g.id === "integrations"}>
        <summary className="docs-group-summary"><span>{g.title}</span><small>{g.tiers ? g.tiers.reduce((sum, t) => sum + t.items.length, 0) : g.items.length}</small><Icon name="chevron" size={13} /></summary>
        <Link className="docs-group-index" href={g.href} aria-current={pathname === g.href ? "page" : undefined}>View all {g.title.toLowerCase()} <span aria-hidden="true">→</span></Link>
        {items}
        {g.tiers ? <div className="docs-tiers">{g.tiers.map(t => <details key={`${t.id}-${Boolean(q)}-${within(t.href)}`} open={Boolean(q) || within(t.href)}>
          <summary><span>{t.title}</span><small>{t.items.length}</small></summary>
          <Link className="docs-tier-index" href={t.href} aria-current={pathname === t.href ? "page" : undefined}>View tier <span aria-hidden="true">→</span></Link>
          <ul>{t.items.map(item => <NavLink key={item.href} item={item} pathname={pathname} />)}</ul>
        </details>)}</div> : null}
      </details>;
    })}
    <p className="docs-sidebar-note">{SKILL_COUNT} guides · Open source</p>
  </nav>;
}
