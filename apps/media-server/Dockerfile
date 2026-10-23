FROM oven/bun:1.4.0 AS operator

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ffmpeg util-linux \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY apps/media-server/package.json apps/media-server/bun.lock ./
RUN bun install --frozen-lockfile --production

COPY apps/media-server/src ./src
COPY apps/media-server/capcodec.md ./capcodec.md

COPY scripts/recording-ownership-preflight.ts ./scripts/
COPY scripts/lib/recording-ownership-preflight.ts scripts/lib/ownership-preflight-download.ts ./scripts/lib/
COPY packages/utils/package.json ./node_modules/@cap/utils/package.json
COPY packages/utils/src/recording-ownership-preflight.ts ./node_modules/@cap/utils/src/recording-ownership-preflight.ts
COPY apps/media-server/recording-ownership-preflight /usr/local/bin/recording-ownership-preflight
RUN mkdir -p apps/media-server \
	&& ln -s ../../src apps/media-server/src \
	&& chmod -R a+rX src scripts node_modules/@cap/utils \
	&& chmod a+r package.json bun.lock capcodec.md \
	&& chmod 755 /usr/local/bin/recording-ownership-preflight

RUN bun --no-env-file test src/__tests__/lib/ownership-preflight-package.test.ts

FROM operator AS release

RUN bun test src/__tests__/lib/audio-quality-policy.test.ts src/__tests__/lib/audio-quality.integration.test.ts \
	&& bun test src/__tests__/lib/audio-quality-formats.integration.test.ts src/__tests__/lib/audio-quality-benchmark.test.ts \
	&& bun test src/__tests__/lib/audio-levels.integration.test.ts \
	&& bun test src/__tests__/lib/drive-resumable-upload.test.ts src/__tests__/lib/storage-upload.test.ts src/__tests__/lib/container-memory.test.ts src/__tests__/lib/parallel-download.test.ts \
	&& bun test src/__tests__/lib/loom-import-limit.test.ts \
	&& bun test src/__tests__/lib/media-size.test.ts src/__tests__/lib/media-probe.integration.test.ts \
	&& bun test src/__tests__/lib/media-audio.integration.test.ts \
	&& bun test src/__tests__/lib/recording-verification.integration.test.ts src/__tests__/lib/job-manager.test.ts \
	&& bun test src/__tests__/lib/media-transfer.test.ts src/__tests__/lib/capcodec-encoder.test.ts src/__tests__/lib/nvenc-encoder.test.ts \
	&& bun test src/__tests__/routes/recording-verification.test.ts \
	&& bun test src/__tests__/routes/video.test.ts \
	&& bun test src/__tests__/lib/lifecycle.test.ts src/__tests__/lib/temp-files.test.ts \
	&& bun test src/__tests__/routes/lifecycle.test.ts \
	&& bun test src/__tests__/routes/peer-jobs.test.ts \
	&& bun test src/__tests__/lib/media-routes-real-world.integration.test.ts \
	&& bun test src/__tests__/lib/media-video.integration.test.ts

RUN MEDIA_SERVER_RECORDING_PERFORMANCE_TESTS=1 bun test \
	src/__tests__/lib/recording-verification.integration.test.ts \
	--test-name-pattern 'streams a complete long recording'

RUN MEDIA_SERVER_TRANSFER_PERFORMANCE_TESTS=1 bun test \
	src/__tests__/lib/media-transfer.integration.test.ts \
	src/__tests__/lib/drive-resumable-upload.test.ts

ENV PORT=3456
EXPOSE 3456

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
	CMD ["bun", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 3456}/health`).then(async (response) => process.exit(response.ok || (await response.json().catch(() => ({}))).status === 'draining' ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["bun", "run", "src/index.ts"]
