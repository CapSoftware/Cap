import { videoProcessingJobs, videos } from "@cap/database/schema";
import { Database } from "@cap/web-backend";
import { CurrentUser, HttpAuthMiddleware, Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
} from "effect/http-api";
import { prepareDesktopRecordingSegments } from "@/lib/desktop-recording-source";
import { apiToHandler } from "@/lib/server";

const Segment = Schema.Struct({
	track: Schema.Literals(["video", "audio"]),
	index: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50_000 })),
});

class Api extends HttpApi.make("RecordingPreparationApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.post("prepare", "/api/recording/prepare", {
			payload: Schema.Struct({
				videoId: Video.VideoId,
				segments: Schema.Array(Segment).check(
					Schema.isMinLength(1),
					Schema.isMaxLength(32),
				),
			}),
			success: Schema.Struct({
				version: Schema.Literal(1),
				prepared: Schema.Array(Segment),
			}),
			error: [
				HttpApiError.NotFound,
				HttpApiError.InternalServerError,
				HttpApiError.Unauthorized,
			],
		}).middleware(HttpAuthMiddleware),
	),
) {}

const ApiLive = HttpApiBuilder.layer(Api).pipe(
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
					Effect.timeout("20 seconds"),
					Effect.catchTag(
						"TimeoutError",
						() => new HttpApiError.InternalServerError(),
					),
				),
			),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const POST = handler;
export const maxDuration = 30;
