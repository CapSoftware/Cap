import { Context, Data } from "effect";
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
	HttpApiMiddleware,
	HttpApiSchema,
} from "effect/http-api";
import * as Schema from "effect/Schema";

const TranscriptionStatus = Schema.Literals([
	"PROCESSING",
	"COMPLETE",
	"ERROR",
	"SKIPPED",
	"NO_AUDIO",
]);
const OSType = Schema.Literals(["macos", "windows", "linux"]);
const LicenseType = Schema.Literals(["yearly", "lifetime"]);

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

const ManagedOrganizationStorage = Schema.NullOr(
	Schema.Struct({
		id: Schema.String,
		name: Schema.String,
		activeProvider: Schema.Literal("s3", "googleDrive"),
	}),
);

const S3ConfigResponse = Schema.Struct({
	config: S3Config,
	source: Schema.Literals(["default", "user", "organization"]),
	managedByOrganization: ManagedOrganizationStorage,
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

const UnauthorizedResponse = Schema.Struct({
	error: Schema.Union([Schema.String, Schema.Boolean]),
}).pipe(HttpApiSchema.status(401));

export class User extends Data.Class<{
	id: string;
	email: string;
	stripeSubscriptionStatus: string;
	thirdPartyStripeSubscriptionId: string | null;
	stripeSubscriptionId: string | null;
	stripeCustomerId: string | null;
}> {}

export class Authentication extends Context.Service<
	Authentication,
	{ user: User }
>()("Authentication") {}

export class AuthMiddleware extends HttpApiMiddleware.Service<
	AuthMiddleware,
	{ provides: Authentication }
>()("Authentication") {}

export class ApiContract extends HttpApi.make("cap-web-api")
	.add(
		HttpApiGroup.make("video")
			.add(
				HttpApiEndpoint.get("getTranscribeStatus", "/video/transcribe/status", {
					query: Schema.Struct({ videoId: Schema.String }),
					success: Schema.Struct({
						transcriptionStatus: Schema.NullOr(TranscriptionStatus),
					}),
					error: HttpApiError.InternalServerError,
				}),
			)
			.add(
				HttpApiEndpoint.delete("delete", "/video/delete", {
					query: Schema.Struct({ videoId: Schema.String }),
					success: Schema.Unknown,
					error: HttpApiError.InternalServerError,
				}),
			)
			.add(
				HttpApiEndpoint.get("getAnalytics", "/video/analytics", {
					query: Schema.Struct({ videoId: Schema.String }),
					success: Schema.Struct({ count: Schema.Number }),
					error: HttpApiError.InternalServerError,
				}),
			),
	)
	.add(
		HttpApiGroup.make("desktop-public")
			.add(
				HttpApiEndpoint.get("getChangelogPosts", "/changelog", {
					query: Schema.Struct({ origin: Schema.String }),
					success: Schema.Array(ChangelogResponse),
					error: HttpApiError.InternalServerError,
				}),
			)
			.add(
				HttpApiEndpoint.get("getChangelogStatus", "/changelog/status", {
					query: Schema.Struct({ version: Schema.String }),
					success: Schema.Struct({ hasUpdate: Schema.Boolean }),
					error: HttpApiError.InternalServerError,
				}),
			),
	)
	.add(
		HttpApiGroup.make("desktop-protected")
			.add(
				HttpApiEndpoint.post("submitFeedback", "/desktop/feedback", {
					headers: AuthHeaders,
					payload: Schema.Struct({
						feedback: Schema.String,
						os: OSType,
						version: Schema.String,
					}),
					success: Schema.Struct({ success: Schema.Boolean }),
					error: [UnauthorizedResponse, HttpApiError.InternalServerError],
				}),
			)
			.add(
				HttpApiEndpoint.get("getUserPlan", "/desktop/plan", {
					headers: AuthHeaders,
					success: Schema.Struct({
						upgraded: Schema.Boolean,
						stripeSubscriptionStatus: Schema.NullOr(Schema.String),
					}),
					error: [UnauthorizedResponse, HttpApiError.InternalServerError],
				}),
			)
			.add(
				HttpApiEndpoint.get("getUserProfile", "/desktop/user/profile", {
					headers: AuthHeaders,
					success: Schema.Struct({
						name: Schema.NullOr(Schema.String),
						email: Schema.NullOr(Schema.String),
						imageUrl: Schema.NullOr(Schema.String),
					}),
					error: [UnauthorizedResponse, HttpApiError.InternalServerError],
				}),
			)
			.add(
				HttpApiEndpoint.get("getS3Config", "/desktop/s3/config/get", {
					headers: AuthHeaders,
					success: S3ConfigResponse,
					error: [UnauthorizedResponse, HttpApiError.InternalServerError],
				}),
			)
			.add(
				HttpApiEndpoint.post("setS3Config", "/desktop/s3/config", {
					headers: AuthHeaders,
					payload: S3Config,
					success: SuccessResponse,
					error: [UnauthorizedResponse, HttpApiError.InternalServerError],
				}),
			)
			.add(
				HttpApiEndpoint.delete("deleteS3Config", "/desktop/s3/config/delete", {
					headers: AuthHeaders,
					success: SuccessResponse,
					error: [UnauthorizedResponse, HttpApiError.InternalServerError],
				}),
			)
			.add(
				HttpApiEndpoint.post("testS3Config", "/desktop/s3/config/test", {
					headers: AuthHeaders,
					payload: S3Config,
					success: SuccessResponse,
					error: [UnauthorizedResponse, HttpApiError.InternalServerError],
				}),
			)
			.add(
				HttpApiEndpoint.post("getProSubscribeURL", "/desktop/subscribe", {
					headers: AuthHeaders,
					payload: Schema.Struct({ priceId: Schema.String }),
					success: Schema.Struct({ url: Schema.String }),
					error: [
						Schema.Struct({
							error: Schema.Literal(true),
							subscription: Schema.optional(Schema.Literal(true)),
						}).pipe(HttpApiSchema.status(400)),
						Schema.Struct({
							error: Schema.Literal(true),
							auth: Schema.Literal(false),
						}).pipe(HttpApiSchema.status(401)),
						UnauthorizedResponse,
						HttpApiError.InternalServerError,
					],
				}),
			)
			.add(
				HttpApiEndpoint.get("getOrgCustomDomain", "/org-custom-domain", {
					headers: AuthHeaders,
					success: Schema.Struct({
						custom_domain: Schema.NullOr(Schema.String),
						domain_verified: Schema.NullOr(Schema.Boolean),
					}),
					error: [
						Schema.Struct({ message: Schema.String }).pipe(
							HttpApiSchema.status(500),
						),
						UnauthorizedResponse,
						HttpApiError.InternalServerError,
					],
				}),
			),
	)
	.prefix("/api") {}

export class LicenseApiContract extends HttpApi.make("cap-license-api").add(
	HttpApiGroup.make("license")
		.add(
			HttpApiEndpoint.post(
				"activateCommercialLicense",
				"/commercial/activate",
				{
					headers: Schema.Struct({
						licensekey: Schema.String,
						instanceid: Schema.String,
					}),
					payload: Schema.Struct({
						reset: Schema.optional(Schema.Boolean),
					}),
					success: Schema.Struct({
						message: Schema.String,
						expiryDate: Schema.optional(Schema.Number),
						refresh: Schema.Number,
					}),
					error: MessageResponse.pipe(HttpApiSchema.status(403)),
				},
			),
		)
		.add(
			HttpApiEndpoint.post(
				"createCommercialCheckoutUrl",
				"/commercial/checkout",
				{
					payload: Schema.Struct({
						type: LicenseType,
						quantity: Schema.optional(
							Schema.Int.check(
								Schema.isGreaterThanOrEqualTo(1),
								Schema.isLessThanOrEqualTo(100),
							),
						),
					}),
					success: Schema.Struct({ url: Schema.String }),
					error: MessageResponse.pipe(HttpApiSchema.status(500)),
				},
			),
		),
) {}
