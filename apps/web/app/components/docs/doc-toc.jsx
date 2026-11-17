"use client";

import { useEffect, useState } from "react";

// "On this page" list. Highlights the section currently under the sticky header.
export function DocToc({ items, title = "On this page" }) {
  const [active, setActive] = useState(items[0]?.id ?? null);

  useEffect(() => {
    if (!items.length) return undefined;
    const headings = items.map((i) => document.getElementById(i.id)).filter(Boolean);
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible[0]) setActive(visible[0].target.id);
    }, { rootMargin: "-100px 0px -65% 0px" });
    headings.forEach((h) => observer.observe(h));
    return () => observer.disconnect();
  }, [items]);

  if (!items.length) return null;
  return <nav className="doc-toc" aria-label={title}>
    <p>{title}</p>
    <ol>
      {items.map((item) => <li key={item.id} className={`depth-${item.depth}${active === item.id ? " is-active" : ""}`}>
        <a href={`#${item.id}`}>{item.step ? <b>{item.step}</b> : null}{item.text}</a>
      </li>)}
    </ol>
  </nav>;
}
