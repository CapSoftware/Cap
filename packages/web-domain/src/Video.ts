import { HttpApiSchema } from "@effect/platform";
import { Rpc, RpcGroup } from "@effect/rpc";
import { Context, Effect, Option, Schema } from "effect";
import { RpcAuthMiddleware } from "./Authentication.ts";
import { InternalError } from "./Errors.ts";
import { FolderId } from "./Folder.ts";
import { OrganisationId } from "./Organisation.ts";
import { PolicyDeniedError } from "./Policy.ts";
import { S3BucketId } from "./S3Bucket.ts";
import { UserId } from "./User.ts";

export const VideoId = Schema.String.pipe(Schema.brand("VideoId"));
export type VideoId = typeof VideoId.Type;

// Purposefully doesn't include password as this is a public class
export class Video extends Schema.Class<Video>("Video")({
	id: VideoId,
	ownerId: UserId,
	orgId: OrganisationId,
	name: Schema.String,
	public: Schema.Boolean,
	source: Schema.Struct({
		type: Schema.Literal("MediaConvert", "local", "desktopMP4"),
	}),
	metadata: Schema.OptionFromNullOr(
		Schema.Record({ key: Schema.String, value: Schema.Any }),
	),
	bucketId: Schema.OptionFromNullOr(S3BucketId),
	folderId: Schema.OptionFromNullOr(FolderId),
	transcriptionStatus: Schema.OptionFromNullOr(
		Schema.Literal("PROCESSING", "COMPLETE", "ERROR", "SKIPPED"),
	),
	width: Schema.OptionFromNullOr(Schema.Number),
	height: Schema.OptionFromNullOr(Schema.Number),
	duration: Schema.OptionFromNullOr(Schema.Number),
	createdAt: Schema.Date,
	updatedAt: Schema.Date,
}) {
	static decodeSync = Schema.decodeSync(Video);

	static getSource(self: Video) {
		if (self.source.type === "MediaConvert")
			return new M3U8Source({
				videoId: self.id,
				ownerId: self.ownerId,
				subpath: "output/video_recording_000.m3u8",
			});

		if (self.source.type === "local")
			return new M3U8Source({
				videoId: self.id,
				ownerId: self.ownerId,
				subpath: "combined-source/stream.m3u8",
			});

		if (self.source.type === "desktopMP4")
			return new Mp4Source({ videoId: self.id, ownerId: self.ownerId });
	}
}

export class UploadProgress extends Schema.Class<UploadProgress>(
	"UploadProgress",
)({
	uploaded: Schema.Int.pipe(Schema.greaterThanOrEqualTo(0)),
	total: Schema.Int.pipe(Schema.greaterThanOrEqualTo(0)),
	startedAt: Schema.Date,
	updatedAt: Schema.Date,
}) {}

export const UploadProgressUpdateInput = Schema.Struct({
	videoId: VideoId,
	uploaded: Schema.Int.pipe(Schema.greaterThanOrEqualTo(0)),
	total: Schema.Int.pipe(Schema.greaterThanOrEqualTo(0)),
	updatedAt: Schema.Date,
});

export const PresignedPost = Schema.Struct({
	url: Schema.String,
	fields: Schema.Record({ key: Schema.String, value: Schema.String }),
});

export const InstantRecordingCreateInput = Schema.Struct({
	orgId: OrganisationId,
	folderId: Schema.OptionFromUndefinedOr(FolderId),
	durationSeconds: Schema.optional(Schema.Number),
	resolution: Schema.optional(Schema.String),
	width: Schema.optional(Schema.Number),
	height: Schema.optional(Schema.Number),
	videoCodec: Schema.optional(Schema.String),
	audioCodec: Schema.optional(Schema.String),
	supportsUploadProgress: Schema.optional(Schema.Boolean),
});

export const InstantRecordingCreateSuccess = Schema.Struct({
	id: VideoId,
	shareUrl: Schema.String,
	upload: PresignedPost,
});

export class ImportSource extends Schema.Class<ImportSource>("ImportSource")({
	source: Schema.Literal("loom"),
	id: Schema.String,
}) {}

export class Mp4Source extends Schema.TaggedClass<Mp4Source>()("Mp4Source", {
	videoId: Schema.String,
	ownerId: Schema.String,
}) {
	getFileKey() {
		return `${this.ownerId}/${this.videoId}/result.mp4`;
	}
}

export class M3U8Source extends Schema.TaggedClass<M3U8Source>()("M3U8Source", {
	videoId: Schema.String,
	ownerId: Schema.String,
	subpath: Schema.String,
}) {
	getPlaylistFileKey() {
		return `${this.ownerId}/${this.videoId}/${this.subpath}`;
	}
}

/*
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
	HttpApiSchema.annotations({ status: 404 }),
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
	Rpc.make("VideoInstantCreate", {
		payload: InstantRecordingCreateInput,
		success: InstantRecordingCreateSuccess,
		error: Schema.Union(InternalError, PolicyDeniedError),
	}).middleware(RpcAuthMiddleware),
	Rpc.make("VideoUploadProgressUpdate", {
		payload: UploadProgressUpdateInput,
		success: Schema.Boolean,
		error: Schema.Union(
			NotFoundError,
			InternalError,
			PolicyDeniedError,
		),
	}).middleware(RpcAuthMiddleware),
	Rpc.make("VideoGetDownloadInfo", {
		payload: VideoId,
		success: Schema.Option(
			Schema.Struct({ fileName: Schema.String, downloadUrl: Schema.String }),
		),
		error: Schema.Union(
			NotFoundError,
			InternalError,
			PolicyDeniedError,
			VerifyVideoPasswordError,
		),
	}),
	Rpc.make("VideosGetThumbnails", {
		payload: Schema.Array(VideoId).pipe(
			Schema.filter((a) => a.length <= 50 || "Maximum of 50 videos at a time"),
		),
		success: Schema.Array(
			Schema.Exit({
				success: Schema.Option(Schema.String),
				failure: Schema.Union(
					NotFoundError,
					PolicyDeniedError,
					VerifyVideoPasswordError,
				),
				defect: Schema.Unknown,
			}),
		),
		error: InternalError,
	}),
	Rpc.make("VideosGetAnalytics", {
		payload: Schema.Array(VideoId).pipe(
			Schema.filter((a) => a.length <= 50 || "Maximum of 50 videos at a time"),
		),
		success: Schema.Array(
			Schema.Exit({
				success: Schema.Struct({ count: Schema.Int }),
				failure: Schema.Union(
					NotFoundError,
					PolicyDeniedError,
					VerifyVideoPasswordError,
				),
				defect: Schema.Unknown,
			}),
		),
		error: InternalError,
	}),
) {}
