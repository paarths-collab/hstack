"use client";

import { useEffect, useRef, useState } from "react";

// Artwork reference is recorded in docs/animation-references.md.
const POSTER = "https://assets.21st.dev/ascii-recipes/thumbnails/user_3IpdLD1ZWUHnoGS8joq93KWue02/2f7f424d-bc97-4970-a24f-b555b90b2f3d.webp";
const VIDEO = "https://assets.21st.dev/ascii-recipes/videos/user_3IpdLD1ZWUHnoGS8joq93KWue02/89986ebe-e2ed-4e1f-a3f7-f149dee0e9fc.mp4";

export function AsciiHero() {
  const videoRef = useRef(null);
  const [motionAllowed, setMotionAllowed] = useState(false);
  const [paused, setPaused] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setMotionAllowed(!preference.matches);
    update();
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !motionAllowed || failed) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !paused) video.play().catch(() => setPaused(true));
      else video.pause();
    }, { threshold: 0.1 });
    observer.observe(video);
    return () => { observer.disconnect(); video.pause(); };
  }, [motionAllowed, paused, failed]);

  return <div className="ascii-hero-art">
    <div className="ascii-art-glow" aria-hidden="true" />
    <div className="ascii-media">
      <img src={POSTER} alt="Blue ASCII network: floating panels connected to a luminous central agent core" width="800" height="800" fetchPriority="high" />
      {motionAllowed && !failed && <video ref={videoRef} src={VIDEO} poster={POSTER} muted loop playsInline preload="none" onError={() => setFailed(true)} aria-hidden="true" />}
    </div>
    <span className="ascii-coordinate ascii-coordinate-top" aria-hidden="true">[ YOUR AGENT / CONNECTED ]</span>
    {motionAllowed && !failed && <div className="ascii-art-caption"><button type="button" onClick={() => setPaused((value) => !value)} aria-label={paused ? "Play artwork animation" : "Pause artwork animation"}>{paused ? "Play motion ▷" : "Pause motion Ⅱ"}</button></div>}
  </div>;
}
