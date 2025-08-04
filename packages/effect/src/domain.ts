import { Context, Data, Effect, Schema } from "effect";
import { db } from "@cap/database";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
  HttpApiMiddleware,
} from "@effect/platform";

import { CurrentUser } from "./CurrentUser";

/**
 * Domain
 *
 * Types, Schemas, Contexts etc used by the app.
 * Leaves implementations to other places.
 */

export class Video extends Schema.Class<Video>("Video")({
  id: Schema.String,
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

export class S3Bucket extends Schema.Class<S3Bucket>("S3Bucket")({
  id: Schema.String,
  ownerId: Schema.String,
  region: Schema.String,
  endpoint: Schema.OptionFromNullOr(Schema.String),
  name: Schema.String,
  accessKeyId: Schema.String,
  secretAccessKey: Schema.String,
}) {
  static decodeSync = Schema.decodeSync(S3Bucket);
}

export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  message: string;
}> {}

export class Database extends Context.Tag("Database")<
  Database,
  {
    execute<T>(
      callback: (_: ReturnType<typeof db>) => Promise<T>
    ): Effect.Effect<T, DatabaseError>;
  }
>() {}

export class VideoNeedsPassword extends Data.TaggedError("VideoNeedsPassword")<{
  id: string;
  cause: "not-provided" | "wrong-password";
}> {}

export class VideoNotFound extends Data.TaggedError("VideoNotFound")<{
  id: string;
}> {}

/**
 * Used to specify a video password provided by a user,
 * whether via cookies in the case of the website,
 * or via query params for the API.
 */
export class VideoPasswordAttachment extends Context.Tag(
  "VideoPasswordAttachment"
)<VideoPasswordAttachment, { password: string }>() {}

/** HTTP **/

export class OptionalUserAuthMiddleware extends HttpApiMiddleware.Tag<OptionalUserAuthMiddleware>()(
  "OptionalUserAuthMiddleware",
  { provides: CurrentUser, optional: true }
) {}

export class UserAuthMiddleware extends HttpApiMiddleware.Tag<UserAuthMiddleware>()(
  "OptionalUserAuthMiddleware",
  { provides: CurrentUser }
) {}

export class Api extends HttpApi.make("Api")
  .add(
    HttpApiGroup.make("root", { topLevel: true }).add(
      HttpApiEndpoint.get("playlist")`/playlist`
        .setUrlParams(
          Schema.Struct({
            videoId: Schema.String,
            videoType: Schema.Literal("video", "audio", "master", "mp4"),
            thumbnail: Schema.OptionFromUndefinedOr(Schema.String),
            fileType: Schema.OptionFromUndefinedOr(Schema.String),
          })
        )
        .addError(HttpApiError.NotFound)
        .addError(HttpApiError.Unauthorized)
        .addError(HttpApiError.Forbidden)
        .addError(HttpApiError.InternalServerError)
        .middleware(OptionalUserAuthMiddleware)
    )
  )
  .prefix("/api") {}
