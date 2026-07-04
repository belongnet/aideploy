/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  serverExternalPackages: ["@aws-sdk/client-secrets-manager"],
};

module.exports = nextConfig;
