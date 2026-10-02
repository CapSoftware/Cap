import { videos } from "@cap/database/schema";
import { Database } from "@cap/web-backend";
import { HttpAuthMiddleware, Video } from "@cap/web-domain";
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
	appendWebEditorImport,
	normalizeWebEditorImportOrder,
	validWebEditorCapImportAsset,
} from "@/lib/editor-imports";
import { encodeWebEditorProject } from "@/lib/editor-project-storage";
import {
	loadEligibleEditorVideo,
	requestMediaEditor,
	verifyOwnedEditorSession,
} from "@/lib/editor-session";
import { apiToHandler } from "@/lib/server";

export const dynamic = "force-dynamic";

const capPath =
	/^content\/imports\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.capbundle$/;
const jobIdPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

class Api extends HttpApi.make("WebEditorCapImportsApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.post("append", "/api/editor/sessions/:id/cap-imports")
			.setPath(Schema.Struct({ id: Schema.String }))
			.setPayload(
				Schema.Struct({
					videoId: Video.VideoId,
					path: Schema.String,
					jobId: Schema.String,
				}),
			)
			.addSuccess(Schema.Struct({ count: Schema.Number }))
			.addError(HttpApiError.BadRequest)
			.addError(HttpApiError.NotFound)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.Conflict)
			.addError(HttpApiError.ServiceUnavailable)
			.addError(HttpApiError.InternalServerError)
			.middleware(HttpAuthMiddleware),
	),
) {}

function asRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function affectedOne(value: unknown) {
	const result = Array.isArray(value) ? value[0] : value;
	return asRecord(result) && result.affectedRows === 1;
}

const readReadyImport = Effect.fn("WebEditorCapImports.readReadyImport")(
	function* (sessionPath: string, jobId: string, path: string, name: string) {
		const response = yield* requestMediaEditor(
			`${sessionPath}/cap-assets/${encodeURIComponent(jobId)}`,
		);
		if (response.status === 404) return yield* new HttpApiError.NotFound();
		if (!response.ok) return yield* new HttpApiError.ServiceUnavailable();
		const job: unknown = yield* Effect.tryPromise({
			try: () => response.json(),
			catch: () => new HttpApiError.ServiceUnavailable(),
		});
		if (
			!asRecord(job) ||
			job.id !== jobId ||
			job.status !== "ready" ||
			!asRecord(job.result) ||
			job.result.path !== path ||
			job.result.name !== name ||
			typeof job.result.clipCount !== "number" ||
			!Number.isSafeInteger(job.result.clipCount) ||
			job.result.clipCount < 1 ||
			job.result.clipCount > 1000 ||
			!asRecord(job.result.projectConfig)
		) {
			return yield* new HttpApiError.ServiceUnavailable();
		}
		if (
			Buffer.byteLength(JSON.stringify(job.result.projectConfig), "utf8") >
			8 * 1024 * 1024
		) {
			return yield* new HttpApiError.ServiceUnavailable();
		}
		return {
			clipCount: job.result.clipCount,
			projectConfig: job.result.projectConfig,
		};
	},
);

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("append", ({ path, payload }) =>
				Effect.gen(function* () {
					if (
						!capPath.test(payload.path) ||
						!jobIdPattern.test(payload.jobId)
					) {
						return yield* new HttpApiError.BadRequest();
					}
					const video = yield* loadEligibleEditorVideo(payload.videoId);
					const sessionPath = yield* verifyOwnedEditorSession(
						payload.videoId,
						path.id,
					);
					const assets = video.metadata?.webEditorVideos?.items ?? [];
					const asset = assets.find((item) => item.path === payload.path);
					if (
						!asset ||
						!validWebEditorCapImportAsset(asset, video.ownerId, video.id)
					) {
						return yield* new HttpApiError.NotFound();
					}
					const clips = video.metadata?.webEditorClips?.items ?? [];
					const priorImports = video.metadata?.webEditorImports;
					const order = normalizeWebEditorImportOrder(
						priorImports,
						clips,
						assets,
						video.ownerId,
						video.id,
					);
					if (!order) return yield* new HttpApiError.ServiceUnavailable();
					const existing = order.items.find(
						(item) => item.kind === "cap" && item.path === payload.path,
					);
					if (existing?.kind === "cap") {
						return { count: existing.clipCount };
					}
					const result = yield* readReadyImport(
						sessionPath,
						payload.jobId,
						payload.path,
						asset.name,
					);
					const nextOrder = appendWebEditorImport(order, {
						kind: "cap",
						path: payload.path,
						clipCount: result.clipCount,
					});
					if (!nextOrder) return yield* new HttpApiError.BadRequest();
					const project = yield* Effect.try({
						try: () => encodeWebEditorProject(result.projectConfig).project,
						catch: () => new HttpApiError.ServiceUnavailable(),
					});
					const priorProject = video.metadata?.webEditorProject;
					const database = yield* Database;
					const serializedProject = JSON.stringify(project);
					const serializedImports = JSON.stringify(nextOrder);
					const updated: unknown = yield* database
						.use((client) =>
							client
								.update(videos)
								.set({
									metadata: sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.webEditorProject', CAST(${serializedProject} AS JSON), '$.webEditorImports', CAST(${serializedImports} AS JSON))`,
								})
								.where(
									and(
										eq(videos.id, video.id),
										eq(videos.ownerId, video.ownerId),
										sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.webEditorProject.savedAt')) <=> ${priorProject?.savedAt ?? null}`,
										sql`COALESCE(JSON_LENGTH(JSON_EXTRACT(${videos.metadata}, '$.webEditorClips.items')), 0) = ${clips.length}`,
										sql`COALESCE(JSON_LENGTH(JSON_EXTRACT(${videos.metadata}, '$.webEditorImports.items')), 0) = ${priorImports?.items.length ?? 0}`,
									),
								),
						)
						.pipe(
							Effect.catchTag("DatabaseError", () =>
								Effect.fail(new HttpApiError.InternalServerError()),
							),
						);
					if (!affectedOne(updated)) return yield* new HttpApiError.Conflict();
					return { count: result.clipCount };
				}),
			),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const POST = handler;
