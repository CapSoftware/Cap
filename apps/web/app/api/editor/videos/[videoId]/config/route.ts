import { videos } from "@cap/database/schema";
import { Database } from "@cap/web-backend";
import { CurrentUser, HttpAuthMiddleware, Video } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
} from "@effect/platform";
import { and, eq, sql } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import {
	hasEditorCaptionContent,
	preserveEditorCaptionContent,
	shouldKeepPriorEditorCaptions,
} from "@/lib/editor-caption-access";
import {
	createEditorCaptionCache,
	restoreEditorCaptionConfig,
} from "@/lib/editor-caption-transport";
import {
	decodeWebEditorProject,
	encodeWebEditorProject,
} from "@/lib/editor-project-storage";
import { loadEligibleEditorVideo } from "@/lib/editor-session";
import { apiToHandler } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

function affectedOne(value: unknown) {
	const result = Array.isArray(value) ? value[0] : value;
	return (
		typeof result === "object" &&
		result !== null &&
		"affectedRows" in result &&
		result.affectedRows === 1
	);
}

class Api extends HttpApi.make("WebEditorBrowserProjectApi").add(
	HttpApiGroup.make("root")
		.add(
			HttpApiEndpoint.get("revision", "/api/editor/videos/:videoId/config")
				.setPath(Schema.Struct({ videoId: Video.VideoId }))
				.addSuccess(Schema.Struct({ savedAt: Schema.NullOr(Schema.String) }))
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.InternalServerError)
				.middleware(HttpAuthMiddleware),
		)
		.add(
			HttpApiEndpoint.put("save", "/api/editor/videos/:videoId/config")
				.setPath(Schema.Struct({ videoId: Video.VideoId }))
				.setPayload(
					Schema.Struct({
						config: Schema.Unknown,
						expectedSavedAt: Schema.optional(Schema.NullOr(Schema.String)),
						preserveExistingPaidCaptions: Schema.optional(Schema.Boolean),
					}),
				)
				.addSuccess(
					Schema.Struct({ saved: Schema.Boolean, savedAt: Schema.String }),
				)
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.ServiceUnavailable)
				.addError(HttpApiError.InternalServerError)
				.addError(HttpApiError.Conflict)
				.middleware(HttpAuthMiddleware),
		),
) {}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers
				.handle("revision", ({ path }) =>
					Effect.gen(function* () {
						const video = yield* loadEligibleEditorVideo(path.videoId);
						return {
							savedAt: video.metadata?.webEditorProject?.savedAt ?? null,
						};
					}),
				)
				.handle("save", ({ path, payload }) =>
					Effect.gen(function* () {
						const video = yield* loadEligibleEditorVideo(path.videoId);
						const priorProject = video.metadata?.webEditorProject;
						if (
							payload.expectedSavedAt !== undefined &&
							payload.expectedSavedAt !== (priorProject?.savedAt ?? null)
						) {
							return yield* new HttpApiError.Conflict();
						}
						const config = payload.config;
						if (
							typeof config !== "object" ||
							config === null ||
							Array.isArray(config)
						) {
							return yield* new HttpApiError.ServiceUnavailable();
						}
						const input = config as Record<string, unknown>;
						const priorConfig = priorProject
							? decodeWebEditorProject(priorProject)
							: null;
						const priorCache =
							"webCaptionRef" in input && priorConfig
								? yield* Effect.tryPromise({
										try: () => createEditorCaptionCache(priorConfig),
										catch: () => new HttpApiError.ServiceUnavailable(),
									})
								: null;
						const restored = restoreEditorCaptionConfig(input, priorCache);
						if (!restored) return yield* new HttpApiError.Conflict();
						if (!video.captionsEnabled && hasEditorCaptionContent(restored)) {
							return yield* new HttpApiError.Forbidden();
						}
						if (
							payload.preserveExistingPaidCaptions === true &&
							hasEditorCaptionContent(restored)
						) {
							return yield* new HttpApiError.Forbidden();
						}
						const storedConfig =
							priorConfig &&
							shouldKeepPriorEditorCaptions(
								restored,
								priorConfig,
								video.captionsEnabled,
								payload.preserveExistingPaidCaptions === true,
							)
								? preserveEditorCaptionContent(restored, priorConfig)
								: restored;
						const storedProject = yield* Effect.try({
							try: () => encodeWebEditorProject(storedConfig).project,
							catch: () => new HttpApiError.ServiceUnavailable(),
						});
						if (storedProject.savedAt === priorProject?.savedAt) {
							storedProject.savedAt = new Date(Date.now() + 1).toISOString();
						}
						const database = yield* Database;
						const user = yield* CurrentUser;
						const savedProject = JSON.stringify(storedProject);
						const updated: unknown = yield* database
							.use((client) =>
								client
									.update(videos)
									.set({
										metadata: sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.webEditorProject', CAST(${savedProject} AS JSON))`,
									})
									.where(
										and(
											eq(videos.id, video.id),
											eq(videos.ownerId, user.id),
											sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.webEditorProject.savedAt')) <=> ${priorProject?.savedAt ?? null}`,
										),
									),
							)
							.pipe(
								Effect.catchTag("DatabaseError", () =>
									Effect.fail(new HttpApiError.InternalServerError()),
								),
							);
						if (!affectedOne(updated)) {
							return yield* new HttpApiError.Conflict();
						}
						return { saved: true, savedAt: storedProject.savedAt };
					}),
				),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const GET = handler;
export const PUT = handler;
