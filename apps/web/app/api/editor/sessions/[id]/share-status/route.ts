import { videoUploads } from "@cap/database/schema";
import { Database } from "@cap/web-backend";
import { HttpAuthMiddleware, Video } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
} from "@effect/platform";
import { eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import { decodeDesktopReuploadToken } from "@/lib/desktop-reupload-token";
import {
	loadEligibleEditorVideo,
	verifyOwnedEditorSession,
} from "@/lib/editor-session";
import { apiToHandler } from "@/lib/server";

export const dynamic = "force-dynamic";

const ShareStatus = Schema.Struct({
	status: Schema.Literal("published", "active", "superseded"),
});

class Api extends HttpApi.make("WebEditorShareStatusApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.post("status", "/api/editor/sessions/:id/share-status")
			.setPath(Schema.Struct({ id: Schema.String }))
			.setPayload(
				Schema.Struct({ videoId: Video.VideoId, uploadId: Schema.String }),
			)
			.addSuccess(ShareStatus)
			.addError(HttpApiError.BadRequest)
			.addError(HttpApiError.NotFound)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.ServiceUnavailable)
			.addError(HttpApiError.InternalServerError)
			.middleware(HttpAuthMiddleware),
	),
) {}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("status", ({ path, payload }) =>
				Effect.gen(function* () {
					if (payload.uploadId.length < 1 || payload.uploadId.length > 32_768)
						return yield* new HttpApiError.BadRequest();
					yield* verifyOwnedEditorSession(payload.videoId, path.id);
					const video = yield* loadEligibleEditorVideo(payload.videoId, true);
					const token = yield* Effect.try({
						try: () => decodeDesktopReuploadToken(payload.uploadId),
						catch: () => new HttpApiError.BadRequest(),
					});
					if (
						!token ||
						token.ownerId !== video.ownerId ||
						token.videoId !== video.id
					) {
						return yield* new HttpApiError.BadRequest();
					}
					if (
						(video.source.type === "desktopMP4" ||
							video.source.type === "webMP4") &&
						video.source.outputKey === token.outputKey
					) {
						return { status: "published" as const };
					}
					const database = yield* Database;
					const [upload] = yield* database
						.use((client) =>
							client
								.select({
									phase: videoUploads.phase,
									rawFileKey: videoUploads.rawFileKey,
								})
								.from(videoUploads)
								.where(eq(videoUploads.videoId, video.id)),
						)
						.pipe(
							Effect.catchTag("DatabaseError", () =>
								Effect.fail(new HttpApiError.InternalServerError()),
							),
						);
					return {
						status:
							upload?.phase === "uploading" &&
							upload.rawFileKey === token.outputKey
								? ("active" as const)
								: ("superseded" as const),
					};
				}),
			),
		),
	),
);

export const POST = apiToHandler(ApiLive);
