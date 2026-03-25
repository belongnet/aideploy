FROM node:20-slim

WORKDIR /app

RUN npm install -g @tobilu/qmd

COPY server.js ./server.js

ENV PORT=4318
ENV QMD_HOME=/var/lib/qmd

RUN mkdir -p /var/lib/qmd

EXPOSE 4318

CMD ["node", "server.js"]
