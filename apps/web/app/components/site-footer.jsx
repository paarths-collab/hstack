import Link from "next/link";
import { SITE_NAME } from "../site-config";
import { BrandMark, Icon } from "./ui-icons";
import { FooterReveal } from "./scroll-reveal";

const columns = [
  { title: "Catalog", links: [["Platforms", "/docs/platforms"], ["Integrations", "/docs/integrations"], ["Core skills", "/docs/core"]] },
  { title: "Install", links: [["macOS & Linux", "/#install-unix"], ["Windows", "/#install-windows"], ["Coding agents", "/#agents"]] },
  { title: "Project", links: [["Source code", "https://github.com/paarths-collab/hstack"], ["Troubleshooting", "https://github.com/paarths-collab/hstack/blob/main/docs/reference/TROUBLESHOOTING.md"], ["Validation status", "https://github.com/paarths-collab/hstack/blob/main/compatibility/VALIDATION.md"]] },
];

function FooterLink({ href, children }) {
  return href.startsWith("http")
    ? <a href={href} target="_blank" rel="noreferrer">{children}</a>
    : <Link href={href}>{children}</Link>;
}

export function SiteFooter() {
  const year = new Date().getFullYear();
  return <footer className="site-footer">
    <div className="footer-paper" data-tone="paper">
      <span className="footer-ghost" aria-hidden="true">HSTACK</span>
      <div className="container footer-paper-inner">
        <div className="footer-meta"><p>Skills for self-hosted Hermes</p><p>© {year}, {SITE_NAME}. Built by Paarth.</p></div>
        <div className="footer-badges">
          <Link href="/" aria-label={`${SITE_NAME} home`}><BrandMark /></Link>
          <a href="https://github.com/paarths-collab/hstack" target="_blank" rel="noreferrer" aria-label="Source code on GitHub"><Icon name="code" size={20} /></a>
          <Link href="/#install" aria-label="Install hstack"><Icon name="terminal" size={20} /></Link>
        </div>
        <div className="footer-meta right"><p><FooterLink href="https://github.com/paarths-collab/hstack">Source</FooterLink> | <Link href="/#faq">FAQs</Link></p><p>Apache 2.0 · {year}</p></div>
      </div>
    </div>
    <div className="footer-blue" data-tone="blue">
      <FooterReveal className="container footer-blue-inner">
        <div className="footer-brand"><Link className="footer-wordmark" href="/" aria-label={`${SITE_NAME} home`}><BrandMark size={44} /><strong>HSTACK</strong></Link><p>Your server. Your agent.</p></div>
        {columns.map((column) => <nav key={column.title} aria-label={column.title}>
          <p>{column.title}</p>
          <ul>{column.links.map(([label, href]) => <li key={label}><FooterLink href={href}>{label}</FooterLink></li>)}</ul>
        </nav>)}
      </FooterReveal>
      <div className="container footer-bottom"><span>Open source. No hstack service in the middle.</span><a href="#main">Back to top ↑</a></div>
    </div>
  </footer>;
}
