FROM oven/bun:1.3-slim
WORKDIR /app
# Public deploys serve the landing pages + waitlist only: the engine is never
# imported and no companion data can exist here.
ENV MVP_PUBLIC=1
COPY package.json ./
COPY server/ server/
COPY site/ site/
# the landing page's dogfood video (served by server.ts at /demo/oni-demo.mp4)
COPY demo/oni-demo.mp4 demo/oni-demo.mp4
CMD ["bun", "server/server.ts"]
