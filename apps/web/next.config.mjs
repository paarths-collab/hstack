import path from "node:path";

const nextConfig = {
  // API routes provide authentication and owner-scoped saved agents.
  // The browser-safe recipe compiler remains shared with the static builder.
  turbopack: {
    root: path.resolve(import.meta.dirname, "../.."),
  },
};

export default nextConfig;
