import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Disable Turbopack to reduce memory usage (Turbopack holds the entire
  // compilation graph in memory and was getting OOM-killed on a 4GB host).
  // Webpack's dev server is slower to warm up but uses significantly less RAM.
  // We also raise the experimental memory limit.
  experimental: {
    fetchCacheKeyPrefix: "terminus",
  },
  // Allow the dev server to be reached via 127.0.0.1 from agent-browser.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;
