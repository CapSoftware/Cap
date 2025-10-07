FROM node:24-slim AS base
RUN corepack enable

FROM base AS builder
WORKDIR /app
COPY . .

RUN corepack enable pnpm
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm i --frozen-lockfile

RUN pnpm run --filter=@cap/web-cluster build
RUN pnpm deploy --filter=@cap/web-cluster out
RUN cd out && node scripts/post-deploy.ts

FROM denoland/deno:2.5.3 AS runner
WORKDIR /app

COPY --from=builder --chown=deno:deno /app/out /app

USER deno

ENTRYPOINT ["deno", "run", "--allow-all"]

EXPOSE 8080
EXPOSE 42069
EXPOSE 42169
