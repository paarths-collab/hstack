"use client";

import { useState } from "react";
import { INSTALL_COMMANDS } from "../catalog";

export function InstallCommand({ label = "Install in one command" }) {
  const [selected, setSelected] = useState(INSTALL_COMMANDS[0].id);
  const [copied, setCopied] = useState(false);
  const current = INSTALL_COMMANDS.find((item) => item.id === selected) ?? INSTALL_COMMANDS[0];

  async function copy() {
    try {
      await navigator.clipboard.writeText(current.command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return <section className="hero-export" role="region" aria-label="Install hstack">
    <p className="hero-export-label">{label}</p>
    <div className="hero-export-terminal">
      <div className="hero-export-tabs" role="group" aria-label="Install method">
        {INSTALL_COMMANDS.map((item) => <button key={item.id} type="button" aria-pressed={selected === item.id} onClick={() => { setSelected(item.id); setCopied(false); }}>{item.label}</button>)}
      </div>
      <div className="hero-export-output install-output" aria-live="polite">
        <code>{current.command}</code>
        <button type="button" className="install-copy" onClick={copy}>{copied ? "Copied ✓" : "Copy"}</button>
      </div>
    </div>
  </section>;
}
