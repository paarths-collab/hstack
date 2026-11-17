"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui-icons";

const kb = (bytes) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

// Tabs over one skill folder: the rendered SKILL.md, then each file as highlighted source with line numbers.
// The HTML is produced at build time from files in this repository.
export function SkillViewer({ html, files, githubBase }) {
  const [tab, setTab] = useState("rendered");
  const rootRef = useRef(null);
  const current = files.find((f) => f.path === tab);

  // One delegated handler gives every code block's Copy button its behaviour.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const onClick = async (event) => {
      const button = event.target.closest("[data-copy-code]");
      if (!button) return;
      const code = button.closest(".code-block, .source-view")?.querySelector("pre")?.innerText ?? "";
      try {
        await navigator.clipboard.writeText(code.replace(/\n$/, ""));
        button.textContent = "Copied ✓";
      } catch {
        button.textContent = "Copy failed";
      }
      setTimeout(() => { button.textContent = "Copy"; }, 1600);
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, []);

  // A contents link pointing into the hidden Guide panel switches back to it first.
  useEffect(() => {
    const onAnchor = (event) => {
      const link = event.target.closest('a[href^="#"]');
      if (!link || !rootRef.current) return;
      const id = decodeURIComponent(link.getAttribute("href").slice(1));
      const target = document.getElementById(id);
      if (!target || !rootRef.current.contains(target) || !target.closest("[hidden]")) return;
      event.preventDefault();
      setTab("rendered");
      requestAnimationFrame(() => {
        document.getElementById(id)?.scrollIntoView();
        history.replaceState(null, "", `#${id}`);
      });
    };
    document.addEventListener("click", onAnchor);
    return () => document.removeEventListener("click", onAnchor);
  }, []);

  return <div className="skill-viewer" ref={rootRef}>
    <div className="viewer-tabs" role="tablist" aria-label="Skill files">
      <button type="button" role="tab" aria-selected={tab === "rendered"} onClick={() => setTab("rendered")}><Icon name="file" size={14} />Guide</button>
      {files.map((f) => <button key={f.path} type="button" role="tab" aria-selected={tab === f.path} onClick={() => setTab(f.path)}><Icon name="code" size={14} />{f.path}</button>)}
    </div>

    <div className="viewer-panel" role="tabpanel" hidden={tab !== "rendered"}>
      <article className="prose" dangerouslySetInnerHTML={{ __html: html }} />
    </div>

    {current ? <div className="viewer-panel source-view" role="tabpanel">
      <div className="source-bar">
        <span><Icon name="file" size={14} />{current.repoPath}</span>
        <span className="source-meta">{current.lines} lines · {kb(current.bytes)}</span>
        <a href={`${githubBase}/${current.repoPath}`} target="_blank" rel="noreferrer">GitHub <Icon name="diagonal" size={12} /></a>
        <button type="button" className="code-copy" data-copy-code>Copy</button>
      </div>
      <div className="source-code" dangerouslySetInnerHTML={{ __html: current.highlighted }} />
    </div> : null}
  </div>;
}
