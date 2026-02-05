FROM oven/bun:1-alpine

RUN apk add --no-cache ffmpeg cairo pango libjpeg-turbo giflib librsvg pixman jq

WORKDIR /app
RUN echo '{"name":"cap-docker","workspaces":["packages/*","apps/*"]}' > package.json

COPY packages/editor-render-spec/package.json ./packages/editor-render-spec/package.json
COPY packages/editor-render-spec/src ./packages/editor-render-spec/src

COPY packages/editor-renderer/package.json ./packages/editor-renderer/package.json
COPY packages/editor-renderer/src ./packages/editor-renderer/src

COPY apps/media-server/package.json ./apps/media-server/package.json

RUN jq 'del(.devDependencies)' packages/editor-render-spec/package.json > tmp.json && mv tmp.json packages/editor-render-spec/package.json && \
    jq 'del(.devDependencies)' packages/editor-renderer/package.json > tmp.json && mv tmp.json packages/editor-renderer/package.json && \
    bun install --production

COPY apps/media-server/src ./apps/media-server/src

ENV PORT=3456
ENV CAP_CANVAS_RENDERER=true
EXPOSE 3456

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
	CMD wget -qO- http://localhost:${PORT}/health || exit 1

CMD ["bun", "run", "apps/media-server/src/index.ts"]
