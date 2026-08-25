import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  outputFileTracingRoot: currentDirectory,
  /* Allow connections to agent health endpoints running on localhost */
  async rewrites() {
    return [];
  },
};

export default nextConfig;
