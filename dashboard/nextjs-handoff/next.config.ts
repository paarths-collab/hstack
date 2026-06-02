import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  // Same-origin proxy to Hermes' :9119 dashboard so the browser stays GET-only
  // and never needs CORS. In production, front :9119 with HTTPS + auth instead.
  async rewrites() {
    const target = process.env.HERMES_BASE || "http://127.0.0.1:9119";
    return [{ source: "/api/:path*", destination: `${target}/api/:path*` }];
  },
};
export default nextConfig;
