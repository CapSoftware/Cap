import {
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "@effect/platform";
import { Schema } from "effect";

import { HttpAuthMiddleware } from "./Authentication.ts";
import { InternalServerError } from "./Http/Errors.ts";
import { OrganisationId } from "./Organisation.ts";
import { PolicyDeniedError } from "./Policy.ts";
import { UserId } from "./User.ts";
import * as Video from "./Video.ts";

const INSTANT_RECORDINGS_PATH = "/instant-recordings";

// Where Http/Api.ts mounts ExtensionHttpApi. Clients that cannot afford a
// runtime dependency on this module keep a literal copy guarded with
// `satisfies typeof EXTENSION_HTTP_PREFIX`, so changing it fails their build.
export const EXTENSION_HTTP_PREFIX = "/extension";

export const ExtensionApiPaths = {
	startAuth: "/auth/start",
	approveAuth: "/auth/approve",
	revokeAuth: "/auth/revoke",
	bootstrap: "/bootstrap",
	createInstantRecording: INSTANT_RECORDINGS_PATH,
	updateInstantRecordingProgress: `${INSTANT_RECORDINGS_PATH}/progress`,
	deleteInstantRecording: (videoId: string) =>
		`${INSTANT_RECORDINGS_PATH}/${encodeURIComponent(videoId)}` as const,
} as const;

export const ExtensionAuthStartParams = Schema.Struct({
	redirectUri: Schema.String,
	state: Schema.OptionFromUndefinedOr(Schema.String),
});

export const ExtensionBootstrapSuccess = Schema.Struct({
	user: Schema.Struct({
		id: UserId,
		email: Schema.String,
	}),
	organization: Schema.Struct({
		id: OrganisationId,
		name: Schema.String,
	}),
	plan: Schema.Struct({
		isPro: Schema.Boolean,
		// null = unlimited (Pro)
		maxRecordingSeconds: Schema.NullOr(Schema.Number),
	}),
});

export const ExtensionUploadProgressUpdateInput = Schema.Struct({
	videoId: Video.VideoId,
	uploaded: Schema.Int.pipe(Schema.greaterThanOrEqualTo(0)),
	total: Schema.Int.pipe(Schema.greaterThanOrEqualTo(0)),
	updatedAt: Schema.DateFromString,
});

export class ExtensionHttpApi extends HttpApiGroup.make("extension")
	// Two-step auth handoff: the GET renders a consent page (it must stay
	// side-effect free — extensions and prefetches can force navigations to
	// it), and the credential is only minted by the same-origin consent-form
	// POST below.
	.add(
		HttpApiEndpoint.get("startAuth", ExtensionApiPaths.startAuth)
			.setUrlParams(ExtensionAuthStartParams)
			.addError(HttpApiError.BadRequest)
			.addError(InternalServerError),
	)
	.add(
		HttpApiEndpoint.post("approveAuth", ExtensionApiPaths.approveAuth)
			.setPayload(
				ExtensionAuthStartParams.pipe(
					HttpApiSchema.withEncoding({ kind: "UrlParams" }),
				),
			)
			.addError(HttpApiError.BadRequest)
			.addError(InternalServerError),
	)
	.add(
		HttpApiEndpoint.post("revokeAuth", ExtensionApiPaths.revokeAuth)
			.middleware(HttpAuthMiddleware)
			.addSuccess(Schema.Struct({ success: Schema.Boolean }))
			.addError(InternalServerError),
	)
	.add(
		HttpApiEndpoint.get("bootstrap", ExtensionApiPaths.bootstrap)
			.middleware(HttpAuthMiddleware)
			.addSuccess(ExtensionBootstrapSuccess)
			.addError(InternalServerError),
	)
	.add(
		HttpApiEndpoint.post(
			"createInstantRecording",
			ExtensionApiPaths.createInstantRecording,
		)
			.middleware(HttpAuthMiddleware)
			.setPayload(Video.InstantRecordingCreateInput)
			.addSuccess(Video.InstantRecordingCreateSuccess)
			.addError(InternalServerError)
			.addError(PolicyDeniedError),
	)
	.add(
		HttpApiEndpoint.post(
			"updateInstantRecordingProgress",
			ExtensionApiPaths.updateInstantRecordingProgress,
		)
			.middleware(HttpAuthMiddleware)
			.setPayload(ExtensionUploadProgressUpdateInput)
			.addSuccess(Schema.Struct({ success: Schema.Boolean }))
			.addError(InternalServerError)
			.addError(Video.NotFoundError)
			.addError(PolicyDeniedError),
	)
	.add(
		HttpApiEndpoint.del(
			"deleteInstantRecording",
			`${INSTANT_RECORDINGS_PATH}/:videoId`,
		)
			.setPath(Schema.Struct({ videoId: Video.VideoId }))
			.middleware(HttpAuthMiddleware)
			.addSuccess(Schema.Struct({ success: Schema.Boolean }))
			.addError(InternalServerError)
			.addError(Video.NotFoundError)
			.addError(PolicyDeniedError),
	)
	.annotateContext(
		OpenApi.annotations({
			title: "Chrome Extension",
			description: "Endpoints used by the first-party Cap Chrome recorder.",
		}),
	) {}
