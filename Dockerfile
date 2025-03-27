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
RUN \
  if [ -f yarn.lock ]; then yarn --frozen-lockfile; \
  elif [ -f package-lock.json ]; then npm ci; \
  elif [ -f pnpm-lock.yaml ]; then corepack enable pnpm && pnpm i; \
  else echo "Lockfile not found." && exit 1; \
  fi


# 2. Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/patches ./patches
COPY . .

# build-time only variables
ARG DOCKER_BUILD=true

# Build and runtime variables
ENV DOCKER_BUILD=true
ENV DATABASE_ENCRYPTION_KEY=8439f729756f4d591032e9d4a1dd366423581a82af0c191187582a39aab935f6
ENV NEXTAUTH_SECRET=8439f729756f4d591032e9d4a1dd366423581a82af0c191187582a39aab935f6
ENV NODE_ENV=production
ENV PORT=3000
ENV NEXT_PUBLIC_WEB_URL=http://localhost:3000
ENV NEXTAUTH_URL=${NEXT_PUBLIC_WEB_URL}
ENV DATABASE_URL=mysql://root:@localhost:3306/planetscale
ENV DATABASE_MIGRATION_URL=mysql://root:@localhost:3306/planetscale
ENV CAP_AWS_ACCESS_KEY=capS3root
ENV CAP_AWS_SECRET_KEY=capS3root
ENV NEXT_PUBLIC_CAP_AWS_BUCKET=capso
ENV NEXT_PUBLIC_CAP_AWS_REGION=us-east-1
ENV NEXT_PUBLIC_CAP_AWS_ENDPOINT=http://localhost:3902

ENV GOOGLE_CLIENT_ID=""
ENV GOOGLE_CLIENT_SECRET=""
ENV RESEND_API_KEY=""
ENV DEEPGRAM_API_KEY=""


RUN corepack enable pnpm && pnpm run build:web

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