"use client";

import { useState } from "react";

export function CopyButton({ text, label = "Copy command", className = "button button-primary", children }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return <button type="button" className={className} onClick={copy} aria-label={copied ? "Copied" : label}>
    {children}<span aria-live="polite">{copied ? "Copied ✓" : label}</span>
  </button>;
}
