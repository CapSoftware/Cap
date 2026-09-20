import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "@effect/platform";
import { Schema } from "effect";

import { HttpAuthMiddleware } from "./Authentication.ts";

export const MAX_UPLOAD_PROBE_BYTES = 1024 * 1024;

export class UploadProbeTooLargeError extends Schema.TaggedError<UploadProbeTooLargeError>()(
	"UploadProbeTooLarge",
	{ error: Schema.String },
	HttpApiSchema.annotations({ status: 413 }),
) {}

export class DesktopHttpApi extends HttpApiGroup.make("desktop")
	.add(
		HttpApiEndpoint.get("checkUploadHealth", "/upload-health")
			.middleware(HttpAuthMiddleware)
			.addSuccess(Schema.Struct({ ok: Schema.Boolean })),
	)
	.add(
		HttpApiEndpoint.post("uploadHealthProbe", "/upload-health")
			.middleware(HttpAuthMiddleware)
			.addSuccess(Schema.Struct({ receivedBytes: Schema.Int }))
			.addError(UploadProbeTooLargeError)
			.addError(HttpApiError.InternalServerError),
	) {}

export class DesktopApiContract extends HttpApi.make("cap-desktop-api")
	.add(DesktopHttpApi)
	.annotateContext(
		OpenApi.annotations({
			title: "Cap Desktop API",
			description: "API used by the Cap desktop client",
		}),
	)
	.prefix("/api/desktop") {}
