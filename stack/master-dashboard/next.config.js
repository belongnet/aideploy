/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  /* Allow connections to agent health endpoints running on localhost */
  async rewrites() {
    return [];
  },
};

module.exports = nextConfig;
