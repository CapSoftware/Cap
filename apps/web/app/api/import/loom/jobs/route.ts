import { CurrentUser, HttpAuthMiddleware } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
} from "@effect/platform";
import { Effect, Layer, Schema } from "effect";
import { getLoomImportSnapshot } from "@/lib/loom-import/snapshot";
import { apiToHandler } from "@/lib/server";

export const dynamic = "force-dynamic";

const DisplayStatus = Schema.Literal(
	"checking",
	"ready",
	"queued",
	"importing",
	"imported",
	"failed",
	"skipped",
	"cancelled",
);

const Item = Schema.Struct({
	id: Schema.String,
	row: Schema.Number,
	url: Schema.String,
	loomId: Schema.NullOr(Schema.String),
	title: Schema.NullOr(Schema.String),
	email: Schema.NullOr(Schema.String),
	space: Schema.NullOr(Schema.String),
	status: DisplayStatus,
	stage: Schema.optional(
		Schema.Literal(
			"starting",
			"waiting",
			"downloading",
			"processing",
			"finishing",
		),
	),
	progress: Schema.optional(Schema.Number),
	error: Schema.optional(Schema.String),
	videoId: Schema.NullOr(Schema.String),
	recordedAt: Schema.NullOr(Schema.String),
	duration: Schema.NullOr(Schema.Number),
	thumb: Schema.NullOr(Schema.String),
	v: Schema.Number,
});

const Snapshot = Schema.Struct({
	job: Schema.Struct({
		id: Schema.String,
		fileName: Schema.String,
		status: Schema.Literal(
			"checking",
			"awaiting_upgrade",
			"importing",
			"completed",
			"cancelled",
		),
		totalCount: Schema.Number,
		createdAt: Schema.String,
		startedAt: Schema.NullOr(Schema.String),
		completedAt: Schema.NullOr(Schema.String),
		createdByMe: Schema.Boolean,
		canStart: Schema.Boolean,
		isPro: Schema.Boolean,
		isAdmin: Schema.Boolean,
	}),
	summary: Schema.NullOr(
		Schema.Struct({
			counts: Schema.Struct({
				checking: Schema.Number,
				ready: Schema.Number,
				queued: Schema.Number,
				importing: Schema.Number,
				imported: Schema.Number,
				failed: Schema.Number,
				skipped: Schema.Number,
				cancelled: Schema.Number,
				total: Schema.Number,
			}),
			totalDuration: Schema.Number,
			importedDuration: Schema.Number,
			owners: Schema.Number,
		}),
	),
	items: Schema.Array(Item),
	cursor: Schema.Number,
	full: Schema.Boolean,
});

class Api extends HttpApi.make("LoomImportJobsApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.get("getJob")`/api/import/loom/jobs`
			.setUrlParams(
				Schema.Struct({
					jobId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)),
					since: Schema.optional(Schema.NumberFromString),
				}),
			)
			.addSuccess(Snapshot)
			.addError(HttpApiError.NotFound)
			.addError(HttpApiError.InternalServerError)
			.middleware(HttpAuthMiddleware),
	),
) {}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("getJob", ({ urlParams }) =>
				Effect.gen(function* () {
					const user = yield* CurrentUser;
					const snapshot = yield* Effect.tryPromise({
						try: () =>
							getLoomImportSnapshot({
								jobId: urlParams.jobId,
								userId: user.id,
								since: urlParams.since,
							}),
						catch: () => new HttpApiError.InternalServerError(),
					});
					if (!snapshot) return yield* new HttpApiError.NotFound();
					return snapshot;
				}),
			),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const GET = handler;
