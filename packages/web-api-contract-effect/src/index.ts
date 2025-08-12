import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpServerError,
} from "@effect/platform";
import * as Schema from "effect/Schema";
import { Context, Data } from "effect";

const TranscriptionStatus = Schema.Literal("PROCESSING", "COMPLETE", "ERROR");
const OSType = Schema.Literal("macos", "windows");
const LicenseType = Schema.Literal("yearly", "lifetime");

const MessageResponse = Schema.Struct({
  message: Schema.String,
});

const SuccessResponse = Schema.Struct({
  success: Schema.Literal(true),
});

const S3Config = Schema.Struct({
  provider: Schema.String,
  accessKeyId: Schema.String,
  secretAccessKey: Schema.String,
  endpoint: Schema.String,
  bucketName: Schema.String,
  region: Schema.String,
});

const S3ConfigResponse = Schema.Struct({
  config: S3Config,
});

const ChangelogResponse = Schema.Struct({
  content: Schema.String,
  title: Schema.String,
  app: Schema.String,
  publishedAt: Schema.String,
  version: Schema.String,
  image: Schema.optional(Schema.String),
});

// Authentication middleware placeholder (would be implemented separately)
const AuthHeaders = Schema.Struct({
  authorization: Schema.String,
});

export class User extends Data.Class<{
  id: string;
  email: string;
  stripeSubscriptionStatus: string;
  thirdPartyStripeSubscriptionId: string | null;
  stripeSubscriptionId: string | null;
  stripeCustomerId: string | null;
}> {}

export class Authentication extends Context.Tag("Authentication")<
  Authentication,
  { user: User }
>() {}

export class AuthMiddleware extends HttpApiMiddleware.Tag<AuthMiddleware>()(
  "Authentication",
  { provides: Authentication }
) {}

export class ApiContract extends HttpApi.make("cap-web-api")
  .add(
    HttpApiGroup.make("video")
      .add(
        HttpApiEndpoint.get("getTranscribeStatus", "/video/transcribe/status")
          .setUrlParams(Schema.Struct({ videoId: Schema.String }))
          .addSuccess(
            Schema.Struct({
              transcriptionStatus: Schema.NullOr(TranscriptionStatus),
            })
          )
      )
      .add(
        HttpApiEndpoint.del("delete", "/video/delete")
          .setUrlParams(Schema.Struct({ videoId: Schema.String }))
          .addSuccess(Schema.Unknown)
      )
      .add(
        HttpApiEndpoint.get("getAnalytics", "/video/analytics")
          .setUrlParams(Schema.Struct({ videoId: Schema.String }))
          .addSuccess(Schema.Struct({ count: Schema.Number }))
      )
  )
  .add(
    HttpApiGroup.make("desktop-public")
      .add(
        HttpApiEndpoint.get("getChangelogPosts", "/changelog")
          .setUrlParams(Schema.Struct({ origin: Schema.String }))
          .addSuccess(Schema.Array(ChangelogResponse))
      )
      .add(
        HttpApiEndpoint.get("getChangelogStatus", "/changelog/status")
          .setUrlParams(Schema.Struct({ version: Schema.String }))
          .addSuccess(Schema.Struct({ hasUpdate: Schema.Boolean }))
      )
  )
  .add(
    HttpApiGroup.make("desktop-protected")
      .addError(
        Schema.Struct({
          error: Schema.Union(Schema.String, Schema.Boolean),
        }),
        { status: 401 }
      )
      .add(
        HttpApiEndpoint.post("submitFeedback", "/desktop/feedback")
          .setHeaders(AuthHeaders)
          .setPayload(
            Schema.Struct({
              feedback: Schema.String,
              os: OSType,
              version: Schema.String,
            })
          )
          .addSuccess(Schema.Struct({ success: Schema.Boolean }))
      )
      .add(
        HttpApiEndpoint.get("getUserPlan", "/desktop/plan")
          .setHeaders(AuthHeaders)
          .addSuccess(
            Schema.Struct({
              upgraded: Schema.Boolean,
              stripeSubscriptionStatus: Schema.NullOr(Schema.String),
            })
          )
      )
      .add(
        HttpApiEndpoint.get("getS3Config", "/desktop/s3/config/get")
          .setHeaders(AuthHeaders)
          .addSuccess(S3ConfigResponse)
      )
      .add(
        HttpApiEndpoint.post("setS3Config", "/desktop/s3/config")
          .setHeaders(AuthHeaders)
          .setPayload(S3Config)
          .addSuccess(SuccessResponse)
      )
      .add(
        HttpApiEndpoint.del("deleteS3Config", "/desktop/s3/config/delete")
          .setHeaders(AuthHeaders)
          .addSuccess(SuccessResponse)
      )
      .add(
        HttpApiEndpoint.post("testS3Config", "/desktop/s3/config/test")
          .setHeaders(AuthHeaders)
          .setPayload(S3Config)
          .addSuccess(SuccessResponse)
      )
      .add(
        HttpApiEndpoint.post("getProSubscribeURL", "/desktop/subscribe")
          .setHeaders(AuthHeaders)
          .setPayload(Schema.Struct({ priceId: Schema.String }))
          .addSuccess(Schema.Struct({ url: Schema.String }))
          .addError(
            Schema.Struct({
              error: Schema.Literal(true),
              subscription: Schema.optional(Schema.Literal(true)),
            }),
            { status: 400 }
          )
          .addError(
            Schema.Struct({
              error: Schema.Literal(true),
              auth: Schema.Literal(false),
            }),
            { status: 401 }
          )
      )
      .add(
        HttpApiEndpoint.get("getOrgCustomDomain", "/org-custom-domain")
          .setHeaders(AuthHeaders)
          .addSuccess(
            Schema.Struct({
              custom_domain: Schema.NullOr(Schema.String),
              domain_verified: Schema.NullOr(Schema.Boolean),
            })
          )
          .addError(Schema.Struct({ message: Schema.String }), { status: 500 })
      )
  )
  .addError(HttpApiError.InternalServerError)
  .prefix("/api") {}

export class LicenseApiContract extends HttpApi.make("cap-license-api").add(
  HttpApiGroup.make("license")
    .add(
      HttpApiEndpoint.post("activateCommercialLicense", "/commercial/activate")
        .setHeaders(
          Schema.Struct({
            licensekey: Schema.String,
            instanceid: Schema.String,
          })
        )
        .setPayload(
          Schema.Struct({
            reset: Schema.optional(Schema.Boolean),
          })
        )
        .addSuccess(
          Schema.Struct({
            message: Schema.String,
            expiryDate: Schema.optional(Schema.Number),
            refresh: Schema.Number,
          })
        )
        .addError(MessageResponse, { status: 403 })
    )
    .add(
      HttpApiEndpoint.post(
        "createCommercialCheckoutUrl",
        "/commercial/checkout"
      )
        .setPayload(
          Schema.Struct({
            type: LicenseType,
            quantity: Schema.optional(
              Schema.Number.pipe(
                Schema.int(),
                Schema.greaterThanOrEqualTo(1),
                Schema.lessThanOrEqualTo(100)
              )
            ),
          })
        )
        .addSuccess(Schema.Struct({ url: Schema.String }))
        .addError(MessageResponse, { status: 500 })
    )
) {}
