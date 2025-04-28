# syntax=docker.io/docker/dockerfile:1

FROM node:20-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable


# 1. Install dependencies only when needed
FROM base AS deps
# Check https://github.com/nodejs/docker-node/tree/b4117f9333da4138b03a546ec926ef50a31506c3#nodealpine to understand why libc6-compat might be needed.
RUN apk add --no-cache libc6-compat


WORKDIR /app

# Install dependencies based on the preferred package manager
COPY package.json yarn.lock* package-lock.json* pnpm-lock.yaml* .npmrc* ./

COPY /patches ./patches



# Install dependencies based on lockfile
RUN if [ -f yarn.lock ]; then \
      yarn --frozen-lockfile; \
    elif [ -f package-lock.json ]; then \
      npm ci; \
    elif [ -f pnpm-lock.yaml ]; then \
      corepack enable pnpm; \
    else \
      echo "Lockfile not found." && exit 1; \
    fi

# Use mount cache for pnpm if pnpm-lock exists
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    if [ -f pnpm-lock.yaml ]; then \
      pnpm i --frozen-lockfile; \
    fi


# 2. Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/patches ./patches
COPY . .

# build-time only variables
ARG DOCKER_BUILD=true

RUN corepack enable pnpm && pnpm i && pnpm run build:web

# We re-install packages instead of copy from deps due to an issue with pnpm and the way it installs app packages under certain conditions
RUN corepack enable pnpm
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm i
RUN pnpm run build:web

# 3. Production image, copy all the files and run next
FROM base AS runner
WORKDIR /app

RUN addgroup -g 1001 -S nodejs
RUN adduser -S nextjs -u 1001


# Automatically leverage output traces to reduce image size
# https://nextjs.org/docs/advanced-features/output-file-tracing
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public
COPY --from=builder --chown=nextjs:nodejs /app/packages/database/migrations ./apps/web/migrations


USER nextjs

EXPOSE 3000

CMD HOSTNAME="0.0.0.0" node apps/web/server.js
