"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { SITE_NAME } from "../site-config";
import { BrandMark, Icon } from "./ui-icons";

const leftLinks = [
  { href: "/docs/platforms", label: "Platforms" },
  { href: "/docs/integrations", label: "Integrations" },
];

const rightLinks = [
  { href: "/docs/how-it-works", label: "How it works" },
  { href: "/docs", label: "Docs" },
];

export function SiteHeader({ compact = false }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [tone, setTone] = useState("blue");
  const headerRef = useRef(null);
  const menuButtonRef = useRef(null);

  // The bar takes the colour of whichever section sits under it: blue over the hero, paper below.
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const probe = (headerRef.current?.offsetHeight ?? 80) / 2;
      const under = [...document.querySelectorAll("[data-tone]")].find((el) => {
        const rect = el.getBoundingClientRect();
        return rect.top <= probe && rect.bottom > probe;
      });
      setTone(under?.dataset.tone ?? "blue");
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  function closeMenu() {
    setMenuOpen(false);
  }

  function handleKeyDown(event) {
    if (event.key === "Escape" && menuOpen) {
      setMenuOpen(false);
      menuButtonRef.current?.focus();
    }
  }

  return <header ref={headerRef} className={`site-header${compact ? " site-header-compact" : ""}`} data-header-tone={tone} onKeyDown={handleKeyDown}>
    <div className="container header-inner">
      <nav className="header-side" aria-label="Main navigation">
        {leftLinks.map((link) => <Link key={link.href} href={link.href}>{link.label}</Link>)}
      </nav>
      <div className="header-brand">
        <Link className="wordmark" href="/" aria-label={`${SITE_NAME} home`}>
          <BrandMark size={32} />
          <span>{SITE_NAME.toUpperCase()}</span>
        </Link>
        {compact ? <Link className="header-docs-link" href="/docs" aria-label="Docs overview">Docs</Link> : null}
      </div>
      <nav className="header-side" aria-label="Resources">
        {rightLinks.map((link) => <Link key={link.href} href={link.href}>{link.label}</Link>)}
        <Link className="nav-cta" href="/#install">Install HSTACK</Link>
      </nav>
      <button ref={menuButtonRef} className="nav-menu-toggle" type="button" aria-label={menuOpen ? "Close menu" : "Open menu"} aria-expanded={menuOpen} aria-controls="mobile-navigation" onClick={() => setMenuOpen((open) => !open)}><span /><span /></button>
    </div>
    <nav id="mobile-navigation" className="site-mobile-nav" aria-label="Mobile navigation" hidden={!menuOpen}>
      {[...leftLinks, ...rightLinks].map((link) => <Link key={link.href} href={link.href} onClick={closeMenu}>{link.label}</Link>)}
      <a href="https://github.com/paarths-collab/hstack" target="_blank" rel="noopener noreferrer" onClick={closeMenu}>GitHub <Icon name="diagonal" size={13} /></a>
      <Link href="/#install" onClick={closeMenu}>Install HSTACK <Icon size={14} /></Link>
    </nav>
  </header>;
}
