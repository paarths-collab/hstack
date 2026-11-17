import Link from "next/link";
import { Icon } from "../ui-icons";
import { ScrollReveal } from "../scroll-reveal";

export function Breadcrumbs({ items }) {
  return <nav className="breadcrumbs" aria-label="Breadcrumb">
    <ol>
      {items.map((c, i) => <li key={c.href}>
        {i < items.length - 1 ? <Link href={c.href}>{c.label}</Link> : <span aria-current="page">{c.label}</span>}
      </li>)}
    </ol>
  </nav>;
}

export function PrevNext({ prev, next }) {
  if (!prev && !next) return null;
  return <nav className="prev-next" aria-label="More docs">
    {prev ? <Link href={prev.href} className="prev"><small>Previous</small><span>{prev.title}</span></Link> : <span />}
    {next ? <Link href={next.href} className="next"><small>Next</small><span>{next.title} <Icon size={14} /></span></Link> : <span />}
  </nav>;
}

// Grid of linked cards used by the overview, category and tier pages.
export function DocCards({ entries }) {
  return <ul className="doc-cards">
    {entries.map((e, index) => <ScrollReveal as="li" key={e.href} delay={(index % 3) * 55}>
      <Link href={e.href}>
        {e.logo ? <span className="doc-card-logo"><img src={e.logo} alt="" width="30" height="30" /></span> : <span className="doc-card-logo mono"><Icon name={e.icon ?? "terminal"} size={18} /></span>}
        <span className="doc-card-text"><strong>{e.title}</strong>{e.summary ? <small>{e.summary}</small> : null}</span>
        {e.meta ? <em>{e.meta}</em> : null}
      </Link>
    </ScrollReveal>)}
  </ul>;
}

export function DocHeader({ kicker, title, children }) {
  return <ScrollReveal as="header" className="doc-header" effect="fade">
    {kicker ? <p className="doc-kicker">{kicker}</p> : null}
    <h1>{title}</h1>
    {children ? <div className="doc-lede">{children}</div> : null}
  </ScrollReveal>;
}
