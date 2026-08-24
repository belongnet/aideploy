const http = require("http");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const port = Number(process.env.PORT || "4318");
const repoRoot = process.env.QMD_REPO_ROOT || "/workspace/repo";
const extraPaths = (process.env.QMD_EXTRA_PATHS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

let indexed = false;
let indexing = null;

async function runQmd(args) {
  return execFileAsync("qmd", args, {
    env: {
      ...process.env,
      HOME: process.env.QMD_HOME || "/var/lib/qmd",
    },
    maxBuffer: 1024 * 1024 * 16,
  });
}

async function ensureIndex() {
  if (indexed) return;
  if (indexing) {
    await indexing;
    return;
  }

  indexing = (async () => {
    const candidates = [
      ["repo", repoRoot],
      ["docs", `${repoRoot}/docs`],
      ...extraPaths.map((value, index) => [`extra-${index + 1}`, value]),
    ];

    for (const [name, path] of candidates) {
      try {
        await runQmd(["collection", "add", path, "--name", name]);
      } catch (error) {
        const stderr = String(error?.stderr || error?.message || "");
        if (!/already/i.test(stderr)) {
          console.warn(`[qmd] collection add failed for ${path}: ${stderr.trim()}`);
        }
      }
    }

    try {
      await runQmd(["embed"]);
    } catch (error) {
      const stderr = String(error?.stderr || error?.message || "");
      if (!/nothing to embed/i.test(stderr)) {
        console.warn(`[qmd] embed failed: ${stderr.trim()}`);
      }
    }
    indexed = true;
  })();

  await indexing;
  indexing = null;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);

  if (url.pathname === "/health") {
    sendJson(res, 200, { status: "ok", indexed });
    return;
  }

  if (url.pathname !== "/query" || req.method !== "GET") {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  const query = (url.searchParams.get("q") || "").trim();
  if (!query) {
    sendJson(res, 400, { error: "q is required" });
    return;
  }

  try {
    await ensureIndex();
    const { stdout } = await runQmd(["query", query]);
    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    sendJson(res, 200, {
      items: [
        {
          title: "Local knowledge query",
          snippet: lines.slice(0, 8).join(" ").slice(0, 1000),
          metadata: {
            query,
          },
        },
      ],
    });
  } catch (error) {
    const stderr = String(error?.stderr || error?.message || "");
    sendJson(res, 500, { error: stderr || "QMD query failed" });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`[qmd] listening on ${port}`);
});
