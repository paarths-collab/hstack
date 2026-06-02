import type { NextConfig } from "next";

const HERMES_BASE = process.env.HERMES_BASE || "http://127.0.0.1:9119";

const config: NextConfig = {
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${HERMES_BASE}/api/:path*` }];
  },
};

export default config;
