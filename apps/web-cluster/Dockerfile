FROM oven/bun:1.4.0 AS bun-bin

FROM node:24-slim AS base
COPY --from=bun-bin /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app

FROM base AS builder
COPY . .
RUN --mount=type=cache,id=bun-1.4.0,target=/root/.bun/install/cache bun install --frozen-lockfile --filter './' --filter '@cap/web-cluster...'
RUN bun run --filter @cap/web-cluster build

FROM base AS production-deps
COPY . .
RUN --mount=type=cache,id=bun-1.4.0,target=/root/.bun/install/cache bun install --frozen-lockfile --production --filter @cap/web-cluster

FROM production-deps AS packager
COPY --from=builder /app/packages /build/packages
COPY --from=builder /app/apps/web-cluster /build/apps/web-cluster
RUN node apps/web-cluster/scripts/deploy.mjs --build-root /build --dependencies-root /app --out /out

FROM denoland/deno:2.5.3 AS runner
WORKDIR /app/apps/web-cluster
COPY --from=packager --chown=deno:deno /out /app
USER deno
ENTRYPOINT ["deno", "run", "--allow-all"]
EXPOSE 8080
EXPOSE 42069
EXPOSE 42169
