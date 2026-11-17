import Link from "next/link";
import { SiteHeader } from "../components/site-header";
import { HERMES_VERSION } from "../catalog";
import { GITHUB } from "../docs-nav";
import { DocsSidebar } from "../components/docs/docs-sidebar";
import { HashScroll } from "../components/docs/hash-scroll";
import "../home.css";
import "./docs.css";

export const metadata = {
  title: { default: "Docs", template: "%s | hstack docs" },
};

export default function DocsLayout({ children }) {
  return <div className="hermes-site docs-site">
    <a className="skip-link" href="#main">Skip to content</a>
    <SiteHeader compact />
    <div className="docs-shell" data-tone="paper">
      <div className="container docs-grid">
        <details className="docs-sidebar-mobile">
          <summary>Browse docs</summary>
          <DocsSidebar />
        </details>
        <aside className="docs-sidebar-wrap"><DocsSidebar /></aside>
        <main id="main" className="docs-content">{children}<HashScroll /></main>
      </div>
    </div>
    <footer className="docs-footer">
      <div className="container docs-footer-inner">
        <span>HSTACK · Skills for Hermes v{HERMES_VERSION}</span>
        <nav aria-label="Docs resources"><Link href="/">Home</Link><a href={GITHUB} target="_blank" rel="noreferrer">GitHub ↗</a></nav>
      </div>
    </footer>
  </div>;
}
