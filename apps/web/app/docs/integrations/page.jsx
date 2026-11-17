import { INTEGRATION_COUNT, TIERS } from "../../catalog";
import { IntegrationsExplorer } from "../../components/integrations-explorer";
import "../../components/integrations-explorer.css";
import { Breadcrumbs } from "../../components/docs/doc-parts";
import { FadeIn } from "../../components/scroll-reveal";

const featured = TIERS.flatMap(tier => tier.items).filter(item => ["notion", "github", "stripe", "linear", "supabase", "tavily"].includes(item.id));

export const metadata = { title: "Integrations", description: `${INTEGRATION_COUNT} integrations in ${TIERS.length} tiers.` };

export default function IntegrationsIndex() {
  return <div className="doc-main wide integrations-page">
    <Breadcrumbs items={[{ label: "Docs", href: "/docs" }, { label: "Integrations", href: "/docs/integrations" }]} />
    <FadeIn as="header" className="catalog-hero">
      <div className="catalog-hero-copy">
        <p className="doc-kicker">Made for your workflow</p>
        <h1>Integrations</h1>
        <p>Connect the tools you already use.<br />Choose a guide and let your coding agent handle the setup.</p>
        <span className="catalog-hero-meta">{INTEGRATION_COUNT} integrations <i aria-hidden="true" /> {TIERS.length} categories to explore</span>
      </div>
      <div className="catalog-logo-mosaic dither-tile" aria-hidden="true">
        {featured.map(item => <span key={item.id}><img src={item.logo} alt="" width="34" height="34" /></span>)}
      </div>
    </FadeIn>
    <IntegrationsExplorer />
  </div>;
}
