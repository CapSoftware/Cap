import { CurrentUser, HttpAuthMiddleware } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
} from "@effect/platform";
import { Effect, Layer, Schema } from "effect";
import {
	abortInfraUpload,
	completeInfraUpload,
	createInfraVideo,
	initiateInfraUpload,
	MAX_PRESIGN_BATCH,
	ownsInfraApp,
	presignInfraUploadParts,
	type UploadResult,
} from "@/lib/infra-video-upload";
import { apiToHandler } from "@/lib/server";

const errorFields = {
	error: Schema.String,
	message: Schema.optional(Schema.String),
	code: Schema.optional(Schema.String),
	hint: Schema.optional(Schema.String),
};

class UploadBadRequest extends Schema.TaggedError<UploadBadRequest>()(
	"UploadBadRequest",
	errorFields,
	HttpApiSchema.annotations({ status: 400 }),
) {}

class UploadRefused extends Schema.TaggedError<UploadRefused>()(
	"UploadRefused",
	errorFields,
	HttpApiSchema.annotations({ status: 402 }),
) {}

class UploadNotFound extends Schema.TaggedError<UploadNotFound>()(
	"UploadNotFound",
	errorFields,
	HttpApiSchema.annotations({ status: 404 }),
) {}

class UploadConflict extends Schema.TaggedError<UploadConflict>()(
	"UploadConflict",
	errorFields,
	HttpApiSchema.annotations({ status: 409 }),
) {}

class UploadFailed extends Schema.TaggedError<UploadFailed>()(
	"UploadFailed",
	errorFields,
	HttpApiSchema.annotations({ status: 500 }),
) {}

const PartNumber = Schema.Int.pipe(Schema.between(1, 10_000));
const Done = Schema.Struct({ success: Schema.Boolean });

class Api extends HttpApi.make("InfraConsoleUploadApi").add(
	HttpApiGroup.make("root")
		.add(
			HttpApiEndpoint.post("create")`/api/developer/console/upload/create`
				.setPayload(
					Schema.Struct({
						appId: Schema.String,
						name: Schema.optional(Schema.String.pipe(Schema.maxLength(255))),
					}),
				)
				.addSuccess(Schema.Struct({ videoId: Schema.String })),
		)
		.add(
			HttpApiEndpoint.post("initiate")`/api/developer/console/upload/initiate`
				.setPayload(
					Schema.Struct({
						appId: Schema.String,
						videoId: Schema.String,
						contentType: Schema.optional(Schema.String),
					}),
				)
				.addSuccess(Schema.Struct({ uploadId: Schema.String })),
		)
		.add(
			HttpApiEndpoint.post("presign")`/api/developer/console/upload/presign`
				.setPayload(
					Schema.Struct({
						appId: Schema.String,
						videoId: Schema.String,
						uploadId: Schema.String,
						partNumbers: Schema.Array(PartNumber).pipe(
							Schema.minItems(1),
							Schema.maxItems(MAX_PRESIGN_BATCH),
						),
					}),
				)
				.addSuccess(
					Schema.Struct({
						parts: Schema.Array(
							Schema.Struct({
								partNumber: Schema.Number,
								presignedUrl: Schema.String,
							}),
						),
					}),
				),
		)
		.add(
			HttpApiEndpoint.post("complete")`/api/developer/console/upload/complete`
				.setPayload(
					Schema.Struct({
						appId: Schema.String,
						videoId: Schema.String,
						uploadId: Schema.String,
						parts: Schema.Array(
							Schema.Struct({
								partNumber: PartNumber,
								etag: Schema.String,
								size: Schema.Number.pipe(Schema.nonNegative()),
							}),
						),
						durationInSecs: Schema.Number.pipe(Schema.positive()),
						width: Schema.optional(Schema.Number),
						height: Schema.optional(Schema.Number),
					}),
				)
				.addSuccess(Done),
		)
		.add(
			HttpApiEndpoint.post("abort")`/api/developer/console/upload/abort`
				.setPayload(
					Schema.Struct({
						appId: Schema.String,
						videoId: Schema.String,
						uploadId: Schema.String,
					}),
				)
				.addSuccess(Done),
		)
		.addError(UploadBadRequest)
		.addError(UploadRefused)
		.addError(UploadNotFound)
		.addError(UploadConflict)
		.addError(UploadFailed)
		.middleware(HttpAuthMiddleware),
) {}

const text = (value: unknown) =>
	typeof value === "string" ? value : undefined;

function refusal(result: Exclude<UploadResult<unknown>, { status: 200 }>) {
	const fields = {
		error: result.body.error,
		message: text(result.body.message),
		code: text(result.body.code),
		hint: text(result.body.hint),
	};
	switch (result.status) {
		case 400:
			return new UploadBadRequest(fields);
		case 402:
			return new UploadRefused(fields);
		case 404:
			return new UploadNotFound(fields);
		case 409:
			return new UploadConflict(fields);
		default:
			return new UploadFailed(fields);
	}
}

const forOwnedApp = <T>(appId: string, work: () => Promise<UploadResult<T>>) =>
	Effect.gen(function* () {
		const user = yield* CurrentUser;
		const result = yield* Effect.tryPromise(async () =>
			(await ownsInfraApp({ id: user.id, email: user.email }, appId))
				? await work()
				: null,
		).pipe(
			Effect.catchAll((error) =>
				Effect.logError(error).pipe(
					Effect.andThen(() =>
						Effect.fail(new UploadFailed({ error: "Upload failed" })),
					),
				),
			),
		);
		if (result === null) {
			return yield* new UploadNotFound({ error: "App not found" });
		}
		if (result.status !== 200) return yield* refusal(result);
		return result.body;
	});

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers
				.handle("create", ({ payload }) =>
					forOwnedApp(payload.appId, () =>
						createInfraVideo({ appId: payload.appId, name: payload.name }),
					),
				)
				.handle("initiate", ({ payload }) =>
					forOwnedApp(payload.appId, () => initiateInfraUpload(payload)),
				)
				.handle("presign", ({ payload }) =>
					forOwnedApp(payload.appId, () => presignInfraUploadParts(payload)),
				)
				.handle("complete", ({ payload }) =>
					forOwnedApp(payload.appId, () => completeInfraUpload(payload)),
				)
				.handle("abort", ({ payload }) =>
					forOwnedApp(payload.appId, () => abortInfraUpload(payload)),
				),
		),
	),
);

export const POST = apiToHandler(ApiLive);
