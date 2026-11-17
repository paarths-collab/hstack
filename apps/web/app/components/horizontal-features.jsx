"use client";

import { Children, useEffect, useRef, useState } from "react";
import { FadeIn, ScrollReveal } from "./scroll-reveal";
import { Icon } from "./ui-icons";

// Pinned-section pattern inspired by UI Layouts' Horizontal Scroll example:
// https://ui-layouts.com/components/horizontal-scroll (MIT, UI LAYOUT).
export function HorizontalFeatures({ children, heading }) {
  const sceneRef = useRef(null);
  const pinRef = useRef(null);
  const trackRef = useRef(null);
  const progressRef = useRef(null);
  const metrics = useRef({ enabled: false, start: 0, distance: 0, overflow: 0, left: 0 });
  const items = Children.toArray(children);
  const [view, setView] = useState({ start: 1, end: 1, previous: false, next: false, driven: false });

  useEffect(() => {
    const scene = sceneRef.current;
    const pin = pinRef.current;
    const track = trackRef.current;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;

    function draw() {
      frame = 0;
      const current = metrics.current;
      if (current.enabled) {
        // Fonts or content above the section can move its document position.
        current.start = scene.getBoundingClientRect().top + window.scrollY - current.header;
        const progress = Math.min(1, Math.max(0, (window.scrollY - current.start) / current.distance));
        const left = progress * current.overflow;
        if (Math.abs(track.scrollLeft - left) > 0.5) track.scrollLeft = left;
        current.left = left;
      }
      const progress = current.overflow > 0 ? track.scrollLeft / current.overflow : 0;
      progressRef.current.style.transform = `scaleX(${progress})`;
      const visible = [...track.children].map((element, index) => ({ element, index })).filter(({ element }) => {
        const left = Math.max(element.offsetLeft, track.scrollLeft + 4);
        const right = Math.min(element.offsetLeft + element.offsetWidth, track.scrollLeft + track.clientWidth - 4);
        return right - left >= element.offsetWidth / 2;
      });
      const fallback = Math.min(items.length - 1, Math.round(progress * (items.length - 1)));
      const next = {
        start: (visible[0]?.index ?? fallback) + 1,
        end: (visible.at(-1)?.index ?? fallback) + 1,
        previous: track.scrollLeft > 2,
        next: track.scrollLeft < current.overflow - 2,
        driven: current.enabled,
      };
      setView(previous => Object.keys(next).every(key => previous[key] === next[key]) ? previous : next);
    }

    function schedule() { if (!frame) frame = requestAnimationFrame(draw); }

    function measure() {
      const header = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--header-h")) || 88;
      const viewport = window.innerHeight - header;
      scene.style.setProperty("--feature-viewport", `${viewport}px`);
      const overflow = Math.max(0, track.scrollWidth - track.clientWidth);
      // Keep oversized panels readable on short screens instead of clipping them.
      const enabled = !reducedMotion.matches && overflow > 0 && pin.scrollHeight <= viewport + 2;
      const distance = Math.round((items.length - 1) * Math.max(400, viewport * 0.85));
      scene.dataset.scrollDriven = String(enabled);
      scene.style.setProperty("--feature-distance", `${distance}px`);
      metrics.current = {
        enabled,
        header,
        start: scene.getBoundingClientRect().top + window.scrollY - header,
        distance,
        overflow,
        left: track.scrollLeft,
      };
      schedule();
    }

    const resize = new ResizeObserver(measure);
    resize.observe(pin);
    resize.observe(track);
    reducedMotion.addEventListener("change", measure);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", schedule, { passive: true });
    track.addEventListener("scroll", schedule, { passive: true });
    measure();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      resize.disconnect();
      reducedMotion.removeEventListener("change", measure);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", schedule);
      track.removeEventListener("scroll", schedule);
    };
  }, [items.length]);

  function goTo(left, instant = false) {
    const current = metrics.current;
    const destination = Math.min(current.overflow, Math.max(0, left));
    const behavior = instant || window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth";
    if (current.enabled) {
      const start = sceneRef.current.getBoundingClientRect().top + window.scrollY - current.header;
      window.scrollTo({ top: start + destination / current.overflow * current.distance, behavior });
    } else {
      trackRef.current.scrollTo({ left: destination, behavior });
    }
  }

  function move(direction) {
    const track = trackRef.current;
    const step = track.children[1]?.offsetLeft - track.children[0]?.offsetLeft || track.clientWidth;
    goTo((Math.round(track.scrollLeft / step) + direction) * step);
  }

  function keyboard(event) {
    if (event.target !== event.currentTarget || event.metaKey || event.altKey || event.ctrlKey) return;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      move(event.key === "ArrowRight" ? 1 : -1);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      goTo(event.key === "Home" ? 0 : metrics.current.overflow, true);
    }
  }

  function focusCard(event) {
    if (!metrics.current.enabled || event.target === event.currentTarget) return;
    const slide = event.target.closest(".feature-slide");
    const track = trackRef.current;
    if (!slide) return;
    const left = metrics.current.left;
    if (slide.offsetLeft >= left + track.clientWidth - 8 || slide.offsetLeft + slide.offsetWidth <= left + 8) {
      goTo(slide.offsetLeft - track.children[0].offsetLeft, true);
    }
  }

  return <div className="feature-scene" ref={sceneRef}>
    <div className="feature-pin" ref={pinRef}>
      <div className="container">
        <FadeIn className="section-title feature-scene-heading">{heading}</FadeIn>
        <div className="feature-carousel">
          <div className="feature-carousel-toolbar">
            <p>{view.driven ? "Scroll down to explore" : "Explore the features"} <span aria-hidden="true">{view.driven ? "↓" : "→"}</span></p>
            <div className="feature-carousel-controls">
              <span className="feature-position" aria-live="polite" aria-label={`Features ${view.start} to ${view.end} of ${items.length}`}>
                {view.start === view.end ? view.start : `${view.start}–${view.end}`} <span>/ {items.length}</span>
              </span>
              <button type="button" aria-label="Previous feature" aria-controls="feature-track" disabled={!view.previous} onClick={() => move(-1)}><Icon name="arrow" className="feature-arrow-back" size={19} /></button>
              <button type="button" aria-label="Next feature" aria-controls="feature-track" disabled={!view.next} onClick={() => move(1)}><Icon name="arrow" size={19} /></button>
            </div>
          </div>
          <div id="feature-track" className="feature-track" ref={trackRef} role="region" aria-label="Scrollable features" tabIndex={0} onKeyDown={keyboard} onFocusCapture={focusCard}>
            {items.map((child, index) => <ScrollReveal
              className="feature-slide"
              key={child.key ?? index}
              effect="masonry"
              delay={(index % 2) * 65}
              style={{ "--masonry-rotation": index % 2 ? "1deg" : "-1deg" }}
            >{child}</ScrollReveal>)}
          </div>
          <div className="feature-scroll-progress" aria-hidden="true"><span ref={progressRef} /></div>
        </div>
      </div>
    </div>
  </div>;
}
