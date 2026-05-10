FROM node:24-bookworm-slim AS node

FROM mysql:8.4 AS runner
WORKDIR /app

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules

COPY apps/web/.next/standalone ./
COPY apps/web/.next/static ./apps/web/.next/static
COPY apps/web/public ./apps/web/public
COPY packages/database/migrations ./apps/web/migrations
COPY packages/database/migrations ./migrations
COPY apps/cloudflare-web/start.sh ./start.sh

RUN chmod +x ./start.sh

ENV PORT=8080
ENV HOSTNAME=0.0.0.0

EXPOSE 8080

CMD ["./start.sh"]
