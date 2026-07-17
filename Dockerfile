FROM oven/bun:1.3-slim
WORKDIR /app
COPY package.json ./
COPY server/ server/
COPY site/ site/
CMD ["bun", "server/server.ts"]
