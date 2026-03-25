/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  /*
   * Proxy /api requests to the agent backend.
   *
   * The agent container for agent N runs on port 810N.
   * The AGENT_PORT env var is injected by docker-compose; it defaults to
   * 8101 (agent 1) for local development.
   */
  async rewrites() {
    const agentPort = process.env.AGENT_PORT || "8101";
    const agentHost = process.env.AGENT_HOST || "agent-1";
    const serviceToken = process.env.AGENT_SERVICE_TOKEN || "";
    const authQuery = serviceToken
      ? `?oc_service_token=${encodeURIComponent(serviceToken)}`
      : "";

    return [
      {
        source: "/api/:path*",
        destination: `http://${agentHost}:${agentPort}/api/:path*${authQuery}`,
      },
    ];
  },
};

module.exports = nextConfig;
