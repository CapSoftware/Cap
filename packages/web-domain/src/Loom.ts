import {
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "@effect/platform";
import { Workflow } from "@effect/workflow";
import { Schema } from "effect";

import { HttpAuthMiddleware } from "./Authentication.ts";
import { DatabaseError } from "./Database.ts";
import { InternalServerError } from "./Http/Errors.ts";
import { PolicyDeniedError } from "./Policy.ts";
import { S3Error } from "./S3Bucket.ts";
import * as Video from "./Video.ts";

export class ExternalLoomError extends Schema.TaggedError<ExternalLoomError>()(
	"ExternalLoomError",
	{ cause: Schema.Unknown },
	HttpApiSchema.annotations({ status: 500 }),
) {}

export class VideoURLInvalidError extends Schema.TaggedError<VideoURLInvalidError>()(
	"VideoURLInvalidError",
	{ status: Schema.Number },
	HttpApiSchema.annotations({ status: 404 }),
) {}

export const ImportVideoLoomData = Schema.Struct({
	userId: Schema.String,
	orgId: Schema.String,
	video: Schema.Struct({
		id: Schema.String,
		name: Schema.String,
		downloadUrl: Schema.URL,
		width: Schema.optional(Schema.Number),
		height: Schema.optional(Schema.Number),
		fps: Schema.optional(Schema.Number),
		durationSecs: Schema.optional(Schema.Number),
	}),
});

export const ImportVideo = Workflow.make({
	name: "LoomImportVideo",
	payload: {
		cap: Schema.Struct({
			userId: Schema.String,
			orgId: Schema.String,
		}),
		loom: ImportVideoLoomData,
		attempt: Schema.optional(Schema.Number),
	},
	success: Schema.Struct({
		videoId: Video.VideoId,
	}),
	error: Schema.Union(
		DatabaseError,
		Video.NotFoundError,
		S3Error,
		ExternalLoomError,
		VideoURLInvalidError,
	),
	idempotencyKey: (p) =>
		`${p.cap.userId}-${p.loom.orgId}-${p.loom.video.id}-${p.attempt ?? 0}`,
});

export class LoomHttpApi extends HttpApiGroup.make("loom")
	.add(
		HttpApiEndpoint.post("importVideo", "/video")
			.setPayload(
				Schema.Struct({
					cap: Schema.Struct({ orgId: Schema.String }),
					loom: ImportVideoLoomData,
				}),
			)
			.addSuccess(Schema.Struct({ videoId: Video.VideoId }))
			.addError(VideoURLInvalidError)
			.addError(InternalServerError)
			.addError(PolicyDeniedError)
			.addError(Video.NotFoundError)
			.addError(ExternalLoomError),
	)
	.middleware(HttpAuthMiddleware)
	.annotateContext(
		OpenApi.annotations({
			title: "Loom",
			description:
				"Endpoints to import Loom videos to Cap. Mostly used by the Loom importer extension.",
		}),
	) {}
