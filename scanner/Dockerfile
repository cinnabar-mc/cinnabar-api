FROM node:24-bookworm-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY source.json ./
COPY scripts/ scripts/
COPY scanner/ scanner/
COPY src/marketplace/ src/marketplace/
RUN node scripts/marketplace-source.mjs && node scripts/build-scanner.mjs
USER node
CMD ["node", "scanner/runner.mjs"]
