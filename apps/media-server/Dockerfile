FROM oven/bun:1.4.0

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ffmpeg \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY apps/media-server/package.json apps/media-server/bun.lock ./
RUN bun install --frozen-lockfile --production

COPY apps/media-server/src ./src

RUN bun test src/__tests__/lib/recording-verification.integration.test.ts src/__tests__/lib/job-manager.test.ts \
	&& bun test src/__tests__/routes/recording-verification.test.ts \
	&& bun test src/__tests__/routes/video.test.ts \
	&& bun test src/__tests__/lib/media-routes-real-world.integration.test.ts \
	&& bun test src/__tests__/lib/media-video.integration.test.ts

RUN MEDIA_SERVER_RECORDING_PERFORMANCE_TESTS=1 bun test \
	src/__tests__/lib/recording-verification.integration.test.ts \
	--test-name-pattern 'streams a complete long recording'

ENV PORT=3456
EXPOSE 3456

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
	CMD ["bun", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 3456}/health`).then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["bun", "run", "src/index.ts"]
