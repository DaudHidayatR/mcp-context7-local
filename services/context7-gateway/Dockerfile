# syntax=docker/dockerfile:1.7

ARG BUN_VERSION=1.3.9

FROM docker.io/oven/bun:${BUN_VERSION}-alpine AS build
WORKDIR /app
ENV NODE_ENV=production
COPY package.json tsconfig.json ./
COPY apps/runner/package.json apps/runner/package.json
COPY packages/mcp-client/package.json packages/mcp-client/package.json
COPY packages/rag/package.json packages/rag/package.json
COPY services/context7-gateway/package.json services/context7-gateway/package.json
RUN bun install --production
COPY services/context7-gateway/src services/context7-gateway/src

FROM docker.io/oven/bun:${BUN_VERSION}-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    GATEWAY_PORT=3100 \
    CHILD_ENV_ALLOWLIST=CONTEXT7_API_KEY,CLIENT_IP_ENCRYPTION_KEY
RUN addgroup -S gateway && adduser -S gateway -G gateway
COPY --from=build --chown=gateway:gateway /app/package.json ./package.json
COPY --from=build --chown=gateway:gateway /app/node_modules ./node_modules
COPY --from=build --chown=gateway:gateway /app/services ./services
USER gateway
EXPOSE 3100
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3100/health || exit 1
CMD ["bun", "run", "services/context7-gateway/src/index.ts"]
