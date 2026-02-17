FROM postgres:16-alpine

# Copy initialization scripts (run in alphabetical order)
COPY init.sql /docker-entrypoint-initdb.d/01-init.sql
COPY bus_trigger.sql /docker-entrypoint-initdb.d/02-bus_trigger.sql
COPY seed.sql /docker-entrypoint-initdb.d/03-seed.sql

ENV POSTGRES_DB=openclaw
ENV POSTGRES_USER=openclaw

HEALTHCHECK --interval=10s --timeout=5s --retries=5 \
  CMD pg_isready -U openclaw -d openclaw || exit 1

EXPOSE 5432
