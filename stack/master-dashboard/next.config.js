const path = require("path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname),
  /* Allow connections to agent health endpoints running on localhost */
  async rewrites() {
    return [];
  },
};

module.exports = nextConfig;
