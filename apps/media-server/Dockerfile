FROM oven/bun:1-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package.json ./
RUN bun install --production

COPY src ./src

ENV PORT=3456
EXPOSE 3456

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
	CMD wget -qO- http://localhost:${PORT}/health || exit 1

CMD ["bun", "run", "src/index.ts"]
