"use client";

import { Children, useEffect, useRef } from "react";

// HSTACK adaptations of the public 21st.dev demos. References and source-access
// notes are in docs/animation-references.md; no gated source is copied here.
export function ScrollReveal({ as: Tag = "div", children, effect = "rise", delay = 0, ...props }) {
  const ref = useRef(null);

  useEffect(() => {
    const element = ref.current;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let observer;
    let animation;
    let revealed = false;

    function show() {
      observer?.disconnect();
      animation?.cancel();
      animation = undefined;
      if (element) element.dataset.revealState = "visible";
    }

    function observe() {
      show();
      if (revealed || preference.matches || !("IntersectionObserver" in window) || !element.animate) return;
      observer = new IntersectionObserver(([entry]) => {
        if (!entry.isIntersecting) return;
        observer.disconnect();
        revealed = true;
        if (element.contains(document.activeElement)) return;
        const masonry = effect === "masonry";
        const blur = effect === "blur" || effect === "footer";
        element.dataset.revealState = "entering";
        animation = element.animate([
          {
            opacity: 0,
            translate: effect === "fade" ? "0 0" : masonry ? "0 36px" : "0 20px",
            rotate: masonry ? "var(--masonry-rotation, -2deg)" : "0deg",
            scale: effect === "footer" ? ".97" : "1",
            filter: blur ? "blur(5px)" : "blur(0px)",
          },
          { opacity: 1, translate: "0 0", rotate: "0deg", scale: "1", filter: "blur(0px)" },
        ], {
          duration: masonry ? 750 : 600,
          delay: Math.min(240, Math.max(0, delay)),
          easing: "cubic-bezier(.22, 1, .36, 1)",
          fill: "backwards",
        });
        animation.finished.then(() => { element.dataset.revealState = "visible"; }, () => {});
      }, { threshold: 0.08, rootMargin: "0px 0px -24px 0px" });
      observer.observe(element);
    }

    function focus(event) {
      if (event.target.matches(":focus-visible")) show();
    }

    function resume() {
      window.removeEventListener("pointerup", resume);
      window.removeEventListener("pointercancel", resume);
      if (animation?.playState === "paused") animation.play();
    }

    function pause() {
      if (animation?.playState !== "running") return;
      // Keep a link in place between pointer-down and pointer-up.
      animation.pause();
      window.addEventListener("pointerup", resume, { once: true });
      window.addEventListener("pointercancel", resume, { once: true });
    }

    observe();
    preference.addEventListener("change", observe);
    element.addEventListener("focusin", focus);
    element.addEventListener("pointerdown", pause);
    return () => {
      show();
      preference.removeEventListener("change", observe);
      element.removeEventListener("focusin", focus);
      element.removeEventListener("pointerdown", pause);
      window.removeEventListener("pointerup", resume);
      window.removeEventListener("pointercancel", resume);
    };
  }, [effect, delay]);

  // HTML is visible by default, including before hydration and without JS.
  return <Tag {...props} ref={ref} data-reveal={effect}>{children}</Tag>;
}

export function FadeIn({ index = 0, ...props }) {
  return <ScrollReveal {...props} effect="blur" delay={index * 70} />;
}

export function MasonryGrid({ children, className = "", ...props }) {
  return <div {...props} className={`scroll-masonry ${className}`}>
    {Children.map(children, (child, index) => <ScrollReveal
      className="scroll-masonry-item"
      effect="masonry"
      delay={(index % 2) * 90}
      style={{ "--masonry-rotation": index % 2 ? "2deg" : "-2deg" }}
    >{child}</ScrollReveal>)}
  </div>;
}

export function FooterReveal({ children, ...props }) {
  return <ScrollReveal {...props} effect="footer">{children}</ScrollReveal>;
}
