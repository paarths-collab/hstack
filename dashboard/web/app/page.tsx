"use client";
import { SpiralAnimation } from "@/components/ui/spiral-animation";
import { useState, useEffect } from "react";
import Link from "next/link";

export default function WelcomePage() {
  const [visible, setVisible] = useState(false);
  useEffect(() => { const t = setTimeout(() => setVisible(true), 1800); return () => clearTimeout(t); }, []);
  return (
    <div className="fixed inset-0 w-full h-full overflow-hidden bg-black">
      <div className="absolute inset-0"><SpiralAnimation /></div>
      <div className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-10 transition-all duration-1000 ease-out ${visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"}`}>
        <Link href="/setup" className="text-white text-2xl tracking-[0.25em] uppercase font-extralight transition-all duration-700 hover:tracking-[0.35em] animate-pulse">
          Enter
        </Link>
      </div>
      <div className={`absolute bottom-8 left-1/2 -translate-x-1/2 z-10 text-white/40 text-[10px] tracking-[0.3em] uppercase mono transition-opacity duration-1000 ${visible ? "opacity-100" : "opacity-0"}`}>
        hstack · self-hosted hermes
      </div>
    </div>
  );
}
