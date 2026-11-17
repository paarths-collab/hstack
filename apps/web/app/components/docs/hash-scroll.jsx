"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

// Opening a link such as /docs/platforms/telegram#rollback lands on that section once the page has rendered.
export function HashScroll() {
  const pathname = usePathname();
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!id) return undefined;
    // Runs after the router's own scroll handling; "instant" so the page-wide smooth scrolling can't be cut short.
    const timer = setTimeout(() => document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "instant" }), 60);
    return () => clearTimeout(timer);
  }, [pathname]);
  return null;
}
