FROM oven/bun:1.3-slim
WORKDIR /app
# Public deploys serve the landing pages + waitlist only: the engine is never
# imported and no companion data can exist here.
ENV MVP_PUBLIC=1
COPY package.json ./
COPY server/ server/
COPY site/ site/
CMD ["bun", "server/server.ts"]
