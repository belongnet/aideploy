# ── Build stage ───────────────────────────────────────────────
FROM python:3.12-slim AS builder

WORKDIR /build

COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# ── Runtime stage ─────────────────────────────────────────────
FROM python:3.12-slim

WORKDIR /app

# Copy installed packages from builder
COPY --from=builder /install /usr/local

# Copy application code
COPY src/ ./src/

# Non-root user
RUN useradd -m -r openclaw && chown -R openclaw:openclaw /app
USER openclaw

ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1

HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD python -c "import httpx; r = httpx.get('http://localhost:${AGENT_PORT:-8101}/health'); r.raise_for_status()" || exit 1

ENTRYPOINT ["python", "-m", "src.main"]
