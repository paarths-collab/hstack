"use client";

import Link from "next/link";
import { useState } from "react";
import { TIERS, INTEGRATION_COUNT } from "../catalog";
import { Icon } from "./ui-icons";
import { ScrollReveal } from "./scroll-reveal";

export function IntegrationsExplorer() {
  const [tier, setTier] = useState("all");
  const visible = TIERS.filter((t) => tier === "all" || t.id === tier);
  const shown = visible.reduce((sum, t) => sum + t.items.length, 0);

  return <div className="integrations-explorer">
    <div className="integration-categories" role="group" aria-label="Filter integrations by category">
      {[{ id: "all", name: "All" }, ...TIERS].map(category => <button
        key={category.id}
        type="button"
        aria-pressed={tier === category.id}
        aria-controls="integration-results"
        onClick={() => setTier(category.id)}
      >{category.name}</button>)}
    </div>
    <p className="integrations-count" aria-live="polite">{shown} of {INTEGRATION_COUNT} integrations</p>
    <div className="tier-list" id="integration-results">
      {visible.map((t) => <section className="tier-block" key={t.id} aria-labelledby={`tier-${t.id}`}>
        <header className="tier-head"><h2 id={`tier-${t.id}`}><Link href={`/docs/integrations/${t.id}`}>{t.name}</Link><small>{t.items.length}</small></h2><span>{t.blurb}</span></header>
        <ul className="logo-grid">
          {t.items.map((i, index) => <ScrollReveal as="li" key={i.id} delay={(index % 3) * 55}><Link className="logo-tile" href={`/docs/integrations/${t.id}/${i.id}`} title={`Read the ${i.name} guide`}>
            <span className="logo-tile-mark"><img src={i.logo} alt="" width="36" height="36" /></span>
            <span className="logo-tile-name">{i.name}</span>
            <span className="logo-tile-summary">{i.summary}</span>
            <span className="logo-tile-more" aria-hidden="true"><Icon name="arrow" size={16} /></span>
          </Link></ScrollReveal>)}
        </ul>
      </section>)}
    </div>
  </div>;
}
