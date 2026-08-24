FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0

WORKDIR /app

RUN npm install -g @tobilu/qmd@2.5.3

COPY server.js ./server.js

ENV PORT=4318
ENV QMD_HOME=/var/lib/qmd

RUN addgroup --system openclaw && \
    adduser --system --ingroup openclaw openclaw && \
    mkdir -p /var/lib/qmd && \
    chown -R openclaw:openclaw /var/lib/qmd /app

USER openclaw

EXPOSE 4318

CMD ["node", "server.js"]
