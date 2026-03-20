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
COPY apps/runner/src apps/runner/src
COPY packages/mcp-client/src packages/mcp-client/src
COPY packages/rag/src packages/rag/src

FROM docker.io/oven/bun:${BUN_VERSION}-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    RUNNER_PORT=3200 \
    RAG_TOP_K=5
RUN addgroup -S runner && adduser -S runner -G runner
COPY --from=build --chown=runner:runner /app/package.json ./package.json
COPY --from=build --chown=runner:runner /app/node_modules ./node_modules
COPY --from=build --chown=runner:runner /app/apps ./apps
COPY --from=build --chown=runner:runner /app/packages ./packages
USER runner
EXPOSE 3200
HEALTHCHECK --interval=20s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3200/ready || exit 1
CMD ["bun", "run", "apps/runner/src/index.ts"]
