import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "hstack · Hermes dashboard",
  description: "One-command self-hosted Hermes Agent — install, configure, visualize.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
