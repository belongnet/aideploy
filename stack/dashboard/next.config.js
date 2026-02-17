/** @type {import('next').NextConfig} */
const nextConfig = {
  /*
   * Proxy /api requests to the agent backend.
   *
   * The agent container for agent N runs on port 810N.
   * The AGENT_PORT env var is injected by docker-compose; it defaults to
   * 8101 (agent 1) for local development.
   */
  async rewrites() {
    const agentPort = process.env.AGENT_PORT || "8101";
    const agentHost = process.env.AGENT_HOST || "localhost";

    return [
      {
        source: "/api/:path*",
        destination: `http://${agentHost}:${agentPort}/api/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
