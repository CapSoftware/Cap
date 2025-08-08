import { Option, Context, Data, Effect, Schema } from "effect";

export const VideoId = Schema.String.pipe(Schema.brand("VideoId"));
export type VideoId = typeof VideoId.Type;

export class Video extends Schema.Class<Video>("Video")({
  id: VideoId,
  password: Schema.OptionFromNullOr(Schema.String),
  ownerId: Schema.String,
  bucketId: Schema.OptionFromNullOr(Schema.String),
  source: Schema.Union(
    Schema.Struct({
      type: Schema.Literal("MediaConvert", "local", "desktopMP4"),
    })
  ),
}) {
  static decodeSync = Schema.decodeSync(Video);
}

/**
 * Used to specify a video password provided by a user,
 * whether via cookies in the case of the website,
 * or via query params for the API.
 */
export class VideoPasswordAttachment extends Context.Tag(
  "VideoPasswordAttachment"
)<VideoPasswordAttachment, { password: string }>() {}

export class VerifyVideoPasswordError extends Data.TaggedError(
  "VerifyVideoPasswordError"
)<{
  id: VideoId;
  cause: "not-provided" | "wrong-password";
}> {}

export const verifyPassword = (video: Video) =>
  Effect.gen(function* () {
    const passwordAttachment = yield* Effect.serviceOption(
      VideoPasswordAttachment
    );

    if (Option.isNone(video.password)) return;

    if (Option.isNone(passwordAttachment))
      return yield* new VerifyVideoPasswordError({
        id: video.id,
        cause: "not-provided",
      });

    if (passwordAttachment.value.password !== video.password.value)
      return yield* new VerifyVideoPasswordError({
        id: video.id,
        cause: "wrong-password",
      });
  });
