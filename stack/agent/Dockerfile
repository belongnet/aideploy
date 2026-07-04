# ── Build stage ───────────────────────────────────────────────
FROM python:3.12-slim@sha256:423ed6ab25b1921a477529254bfeeabf5855151dc2c3141699a1bfc852199fbf AS builder

WORKDIR /build

COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# ── Runtime stage ─────────────────────────────────────────────
FROM python:3.12-slim@sha256:423ed6ab25b1921a477529254bfeeabf5855151dc2c3141699a1bfc852199fbf

WORKDIR /app

# Copy installed packages from builder
COPY --from=builder /install /usr/local

# Copy application code
COPY src/ ./src/

# Writable workspace for agent-built portals (mounted as a volume in compose).
RUN mkdir -p /workspace/sites

# Non-root user
RUN useradd -m -r openclaw \
    && chown -R openclaw:openclaw /app /workspace
USER openclaw

ENV AGENT_WORKSPACE_DIR=/workspace

ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1

HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD python -c "import httpx; r = httpx.get('http://localhost:${AGENT_PORT:-8101}/health'); r.raise_for_status()" || exit 1

ENTRYPOINT ["python", "-m", "src.main"]
