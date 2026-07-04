FROM pgvector/pgvector:pg16@sha256:ad2e18408bf447f62092a8a5259e7df10505c5a0360bd1a1853ac8b8b0763da2

# Copy initialization scripts (run in alphabetical order)
COPY init.sql /docker-entrypoint-initdb.d/01-init.sql
COPY bus_trigger.sql /docker-entrypoint-initdb.d/02-bus_trigger.sql
COPY seed.sql /docker-entrypoint-initdb.d/03-seed.sql
COPY 04-memory.sql /docker-entrypoint-initdb.d/04-memory.sql
COPY 05-backup-recovery.sql /docker-entrypoint-initdb.d/05-backup-recovery.sql

ENV POSTGRES_DB=openclaw
ENV POSTGRES_USER=openclaw

HEALTHCHECK --interval=10s --timeout=5s --retries=5 \
  CMD pg_isready -U openclaw -d openclaw || exit 1

EXPOSE 5432
