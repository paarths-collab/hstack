import "./globals.css";
import "./motion.css";
import localFont from "next/font/local";
import { SITE_DESCRIPTION, SITE_NAME } from "./site-config";

const condensed = localFont({
  src: [
    { path: "./fonts/BarlowCondensed-ExtraLight.ttf", weight: "200", style: "normal" },
    { path: "./fonts/BarlowCondensed-Regular.ttf", weight: "400", style: "normal" },
  ],
  variable: "--font-condensed",
  display: "swap",
});

export const metadata = {
  title: {
    default: `${SITE_NAME} — Hermes on your own server`,
    template: `%s | ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={condensed.variable} data-scroll-behavior="smooth">
      <body>{children}</body>
    </html>
  );
}
