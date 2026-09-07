import {
	CurrentUser,
	HttpAuthMiddleware,
	Organisation,
	User,
} from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
} from "@effect/platform";
import { Effect, Layer, Schema } from "effect";
import { start } from "workflow/api";
import {
	ExtensionLoomAuthorizationError,
	MAX_EXTENSION_LOOM_EMAIL_LENGTH,
	MAX_EXTENSION_LOOM_ROW_NUMBER,
	MAX_EXTENSION_LOOM_SPACE_LENGTH,
	MAX_EXTENSION_LOOM_URL_LENGTH,
} from "@/lib/extension-loom-import";
import {
	MAX_LOOM_BATCH_ROWS,
	MAX_LOOM_BATCH_SOURCE_ROWS,
	MAX_LOOM_BATCH_WORKSPACE_LENGTH,
} from "@/lib/loom-batch";
import {
	getLoomBatchStatus,
	LoomBatchConflictError,
	LoomBatchNotFoundError,
	LoomBatchValidationError,
	startLoomBatchImport,
} from "@/lib/loom-batch-import";
import { apiToHandler } from "@/lib/server";
import { importLoomBatchWorkflow } from "@/workflows/import-loom-batch";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const BatchRow = Schema.Struct({
	rowNumber: Schema.Int.pipe(
		Schema.greaterThanOrEqualTo(1),
		Schema.lessThanOrEqualTo(MAX_EXTENSION_LOOM_ROW_NUMBER),
	),
	loomUrl: Schema.String.pipe(
		Schema.minLength(1),
		Schema.maxLength(MAX_EXTENSION_LOOM_URL_LENGTH),
	),
	userEmail: Schema.String.pipe(
		Schema.minLength(1),
		Schema.maxLength(MAX_EXTENSION_LOOM_EMAIL_LENGTH),
	),
	spaceName: Schema.optional(
		Schema.String.pipe(Schema.maxLength(MAX_EXTENSION_LOOM_SPACE_LENGTH)),
	),
});

const BatchSource = Schema.Struct({
	workspace: Schema.String.pipe(
		Schema.minLength(1),
		Schema.maxLength(MAX_LOOM_BATCH_WORKSPACE_LENGTH),
	),
	from: Schema.String.pipe(Schema.length(10)),
	to: Schema.String.pipe(Schema.length(10)),
	totalRows: Schema.Int.pipe(
		Schema.greaterThanOrEqualTo(1),
		Schema.lessThanOrEqualTo(MAX_LOOM_BATCH_SOURCE_ROWS),
	),
	omittedRows: Schema.Int.pipe(
		Schema.greaterThanOrEqualTo(0),
		Schema.lessThanOrEqualTo(MAX_LOOM_BATCH_SOURCE_ROWS),
	),
});

const StartPayload = Schema.Struct({
	requestId: Schema.UUID,
	expectedUserId: User.UserId,
	expectedDefaultPublic: Schema.Boolean,
	organizationId: Organisation.OrganisationId,
	rows: Schema.Array(BatchRow).pipe(
		Schema.minItems(1),
		Schema.maxItems(MAX_LOOM_BATCH_ROWS),
	),
	source: BatchSource,
});

const StartResponse = Schema.Struct({
	operationId: Schema.String,
	dashboardPath: Schema.String,
});

const StatusParams = Schema.Struct({
	operationId: Schema.String.pipe(Schema.length(15)),
	organizationId: Organisation.OrganisationId,
	report: Schema.optional(Schema.Literal("1")),
});

const StatusCounts = Schema.Struct({
	total: Schema.Int,
	queued: Schema.Int,
	processing: Schema.Int,
	ready: Schema.Int,
	failed: Schema.Int,
	uncertain: Schema.Int,
});

const StatusRow = Schema.Struct({
	rowNumber: Schema.Int,
	userEmail: Schema.String,
	spaceName: Schema.optional(Schema.String),
	loomVideoId: Schema.String,
	state: Schema.Literal("queued", "processing", "ready", "failed", "uncertain"),
	videoId: Schema.optional(Schema.String),
	error: Schema.optional(Schema.String),
	existing: Schema.optional(Schema.Boolean),
});

const StatusResponse = Schema.Struct({
	operationId: Schema.String,
	organizationId: Schema.String,
	state: Schema.Literal(
		"queued",
		"running",
		"dispatched",
		"complete",
		"failed",
	),
	phase: Schema.Literal(
		"queued",
		"preparing",
		"dispatching",
		"monitoring",
		"complete",
		"failed",
	),
	source: BatchSource,
	counts: StatusCounts,
	currentRowNumber: Schema.NullOr(Schema.Int),
	rows: Schema.Array(StatusRow),
	rowsTruncated: Schema.Boolean,
	error: Schema.optional(Schema.String),
	createdAt: Schema.String,
	updatedAt: Schema.String,
	completedAt: Schema.NullOr(Schema.String),
});

class Api extends HttpApi.make("ExtensionLoomBatchImportApi").add(
	HttpApiGroup.make("loomBatchImport")
		.add(
			HttpApiEndpoint.post("startBatch")`/api/extension/import-loom/batch`
				.middleware(HttpAuthMiddleware)
				.setPayload(StartPayload)
				.addSuccess(StartResponse)
				.addError(HttpApiError.BadRequest)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.Conflict)
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.InternalServerError),
		)
		.add(
			HttpApiEndpoint.get("getBatch")`/api/extension/import-loom/batch`
				.middleware(HttpAuthMiddleware)
				.setUrlParams(StatusParams)
				.addSuccess(StatusResponse)
				.addError(HttpApiError.BadRequest)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.Conflict)
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.InternalServerError),
		),
) {}

const internalError = (cause: unknown) =>
	Effect.logError(cause).pipe(
		Effect.andThen(Effect.fail(new HttpApiError.InternalServerError())),
	);

type BatchHttpError =
	| HttpApiError.BadRequest
	| HttpApiError.Forbidden
	| HttpApiError.Conflict
	| HttpApiError.NotFound
	| HttpApiError.InternalServerError;

const mapBatchError = (
	cause: unknown,
): Effect.Effect<never, BatchHttpError> => {
	if (cause instanceof ExtensionLoomAuthorizationError) {
		return Effect.fail(new HttpApiError.Forbidden());
	}
	if (cause instanceof LoomBatchValidationError) {
		return Effect.fail(new HttpApiError.BadRequest());
	}
	if (cause instanceof LoomBatchConflictError) {
		return Effect.fail(new HttpApiError.Conflict());
	}
	if (cause instanceof LoomBatchNotFoundError) {
		return Effect.fail(new HttpApiError.NotFound());
	}
	return internalError(cause);
};

const startBatch = ({
	payload,
}: {
	payload: Schema.Schema.Type<typeof StartPayload>;
}) =>
	Effect.gen(function* () {
		const currentUser = yield* CurrentUser;
		return yield* Effect.tryPromise({
			try: () =>
				startLoomBatchImport({
					request: {
						...payload,
						rows: [...payload.rows],
					},
					currentUserId: currentUser.id,
					startBatchWorkflow: async (operationId) => {
						await start(importLoomBatchWorkflow, [{ operationId }]);
					},
				}),
			catch: (cause) => cause,
		});
	}).pipe(Effect.catchAll(mapBatchError));

const getBatch = ({
	urlParams,
}: {
	urlParams: Schema.Schema.Type<typeof StatusParams>;
}) =>
	Effect.gen(function* () {
		const currentUser = yield* CurrentUser;
		return yield* Effect.tryPromise({
			try: () =>
				getLoomBatchStatus({
					operationId: urlParams.operationId,
					organizationId: urlParams.organizationId,
					currentUserId: currentUser.id,
					includeAllRows: urlParams.report === "1",
				}),
			catch: (cause) => cause,
		});
	}).pipe(Effect.catchAll(mapBatchError));

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "loomBatchImport", (handlers) =>
			handlers.handle("startBatch", startBatch).handle("getBatch", getBatch),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const GET = handler;
export const POST = handler;
