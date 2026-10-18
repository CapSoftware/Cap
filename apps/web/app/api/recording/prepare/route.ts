import { videoProcessingJobs, videos } from "@cap/database/schema";
import { Database } from "@cap/web-backend";
import { CurrentUser, HttpAuthMiddleware, Video } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
} from "@effect/platform";
import { and, eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import { prepareDesktopRecordingSegments } from "@/lib/desktop-recording-source";
import { apiToHandler } from "@/lib/server";

const Segment = Schema.Struct({
	track: Schema.Literal("video", "audio"),
	index: Schema.Int.pipe(Schema.between(1, 50_000)),
});

class Api extends HttpApi.make("RecordingPreparationApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.post("prepare")`/api/recording/prepare`
			.setPayload(
				Schema.Struct({
					videoId: Video.VideoId,
					segments: Schema.Array(Segment).pipe(
						Schema.minItems(1),
						Schema.maxItems(32),
					),
				}),
			)
			.addSuccess(
				Schema.Struct({
					version: Schema.Literal(1),
					prepared: Schema.Array(Segment),
				}),
			)
			.addError(HttpApiError.NotFound)
			.addError(HttpApiError.InternalServerError)
			.middleware(HttpAuthMiddleware),
	),
) {}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("prepare", ({ payload }) =>
				Effect.gen(function* () {
					const user = yield* CurrentUser;
					const database = yield* Database;
					const prepared = yield* database
						.use(async (client) => {
							const read = () =>
								client
									.select({ video: videos, jobId: videoProcessingJobs.videoId })
									.from(videos)
									.leftJoin(
										videoProcessingJobs,
										eq(videoProcessingJobs.videoId, videos.id),
									)
									.where(
										and(
											eq(videos.id, payload.videoId),
											eq(videos.ownerId, user.id),
										),
									);
							const [current] = await read();
							if (!current) return null;
							if (
								current.jobId ||
								current.video.source?.type !== "desktopSegments"
							)
								return [];
							return prepareDesktopRecordingSegments(
								current.video,
								payload.segments,
								async () => {
									const [latest] = await read();
									return Boolean(
										latest &&
											!latest.jobId &&
											latest.video.source?.type === "desktopSegments",
									);
								},
							);
						})
						.pipe(
							Effect.catchTag("DatabaseError", () =>
								Effect.fail(new HttpApiError.InternalServerError()),
							),
						);
					if (prepared === null) return yield* new HttpApiError.NotFound();
					return { version: 1 as const, prepared };
				}).pipe(
					Effect.timeoutFail({
						duration: "20 seconds",
						onTimeout: () => new HttpApiError.InternalServerError(),
					}),
				),
			),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const POST = handler;
export const maxDuration = 30;
