# 1. Base image
FROM node:20-alpine AS base
RUN corepack enable

# 2. Builder image
FROM base AS builder
WORKDIR /app
COPY . .

RUN corepack enable pnpm
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm i --frozen-lockfile

RUN pnpm run --filter=@cap/tasks build

# 3. Production image
FROM base AS runner
WORKDIR /app

RUN addgroup -g 1001 -S nodejs
RUN adduser -S tasks -u 1001

COPY --from=builder /app/apps/tasks/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/tasks/package.json .

USER tasks

CMD ["node", "dist/src/index.js"]
