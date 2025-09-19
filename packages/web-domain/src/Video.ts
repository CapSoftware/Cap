import { Rpc, RpcGroup } from "@effect/rpc";
import { Context, Effect, Option, Schema } from "effect";
import { RpcAuthMiddleware } from "./Authentication";
import { InternalError } from "./Errors";
import { FolderId } from "./Folder";
import { PolicyDeniedError } from "./Policy";
import { S3BucketId } from "./S3Bucket";

export const VideoId = Schema.String.pipe(Schema.brand("VideoId"));
export type VideoId = typeof VideoId.Type;

// Purposefully doesn't include password as this is a public class
export class Video extends Schema.Class<Video>("Video")({
	id: VideoId,
	ownerId: Schema.String,
	name: Schema.String,
	public: Schema.Boolean,
	metadata: Schema.OptionFromNullOr(
		Schema.Record({ key: Schema.String, value: Schema.Any }),
	),
	source: Schema.Struct({
		type: Schema.Literal("MediaConvert", "local", "desktopMP4"),
	}),
	bucketId: Schema.OptionFromNullOr(S3BucketId),
	folderId: Schema.OptionFromNullOr(FolderId),
	transcriptionStatus: Schema.OptionFromNullOr(
		Schema.Literal("PROCESSING", "COMPLETE", "ERROR"),
	),
	createdAt: Schema.Date,
	updatedAt: Schema.Date,
}) {
	static decodeSync = Schema.decodeSync(Video);

	toJS = () => Schema.encode(Video)(this).pipe(Effect.orDie);
}

export class UploadProgress extends Schema.Class<UploadProgress>(
	"UploadProgress",
)({
	uploaded: Schema.Int.pipe(Schema.greaterThanOrEqualTo(0)),
	total: Schema.Int.pipe(Schema.greaterThanOrEqualTo(0)),
	startedAt: Schema.Date,
	updatedAt: Schema.Date,
}) {}

/**
 * Used to specify a video password provided by a user,
 * whether via cookies in the case of the website,
 * or via query params for the API.
 */
export class VideoPasswordAttachment extends Context.Tag(
	"VideoPasswordAttachment",
)<VideoPasswordAttachment, { password: Option.Option<string> }>() {}

export class VerifyVideoPasswordError extends Schema.TaggedError<VerifyVideoPasswordError>()(
	"VerifyVideoPasswordError",
	{
		id: VideoId,
		cause: Schema.Literal("not-provided", "wrong-password"),
	},
) {}

export const verifyPassword = (video: Video, password: Option.Option<string>) =>
	Effect.gen(function* () {
		const passwordAttachment = yield* Effect.serviceOption(
			VideoPasswordAttachment,
		);

		if (Option.isNone(password)) return;

		if (
			Option.isNone(passwordAttachment) ||
			Option.isNone(passwordAttachment.value.password)
		)
			return yield* new VerifyVideoPasswordError({
				id: video.id,
				cause: "not-provided",
			});

		if (passwordAttachment.value.password.value !== password.value)
			return yield* new VerifyVideoPasswordError({
				id: video.id,
				cause: "wrong-password",
			});
	});

export class NotFoundError extends Schema.TaggedError<NotFoundError>()(
	"VideoNotFoundError",
	{},
) {}

export class VideoRpcs extends RpcGroup.make(
	Rpc.make("VideoDelete", {
		payload: VideoId,
		error: Schema.Union(NotFoundError, InternalError, PolicyDeniedError),
	}).middleware(RpcAuthMiddleware),
	Rpc.make("VideoDuplicate", {
		payload: VideoId,
		error: Schema.Union(NotFoundError, InternalError, PolicyDeniedError),
	}).middleware(RpcAuthMiddleware),
	Rpc.make("GetUploadProgress", {
		payload: VideoId,
		success: Schema.Option(UploadProgress),
		error: Schema.Union(
			NotFoundError,
			InternalError,
			PolicyDeniedError,
			VerifyVideoPasswordError,
		),
	}),
) {}
