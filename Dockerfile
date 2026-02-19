# syntax=docker/dockerfile:1.7

ARG BUN_VERSION=1.3.9
ARG CONTEXT7_VERSION=1.0.31

FROM docker.io/oven/bun:${BUN_VERSION}-alpine AS build
ARG CONTEXT7_VERSION
WORKDIR /app
ENV NODE_ENV=production
RUN printf '{"name":"context7-mcp-runtime","private":true}\n' > package.json \
 && bun add --exact "@upstash/context7-mcp@${CONTEXT7_VERSION}" \
 && rm -rf /root/.bun/install/cache

FROM docker.io/oven/bun:${BUN_VERSION}-alpine
ARG CONTEXT7_VERSION
WORKDIR /app
ENV NODE_ENV=production \
    CONTEXT7_VERSION=${CONTEXT7_VERSION}
COPY --from=build /app/node_modules /app/node_modules
ENTRYPOINT ["bun", "/app/node_modules/@upstash/context7-mcp/dist/index.js"]
