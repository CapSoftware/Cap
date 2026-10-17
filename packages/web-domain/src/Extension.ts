import { Schema } from "effect";
import {
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "effect/http-api";

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
	uploaded: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	updatedAt: Schema.DateFromString,
});

export class ExtensionHttpApi extends HttpApiGroup.make("extension")
	// Two-step auth handoff: the GET renders a consent page (it must stay
	// side-effect free — extensions and prefetches can force navigations to
	// it), and the credential is only minted by the same-origin consent-form
	// POST below.
	.add(
		HttpApiEndpoint.get("startAuth", ExtensionApiPaths.startAuth, {
			query: ExtensionAuthStartParams,
			error: [HttpApiError.BadRequest, InternalServerError],
		}),
	)
	.add(
		HttpApiEndpoint.post("approveAuth", ExtensionApiPaths.approveAuth, {
			payload: ExtensionAuthStartParams.pipe(HttpApiSchema.asFormUrlEncoded()),
			error: [HttpApiError.BadRequest, InternalServerError],
		}),
	)
	.add(
		HttpApiEndpoint.post("revokeAuth", ExtensionApiPaths.revokeAuth, {
			success: Schema.Struct({ success: Schema.Boolean }),
			error: InternalServerError,
		}).middleware(HttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.get("bootstrap", ExtensionApiPaths.bootstrap, {
			success: ExtensionBootstrapSuccess,
			error: InternalServerError,
		}).middleware(HttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post(
			"createInstantRecording",
			ExtensionApiPaths.createInstantRecording,
			{
				payload: Video.InstantRecordingCreateInput,
				success: Video.InstantRecordingCreateSuccess,
				error: [InternalServerError, PolicyDeniedError],
			},
		).middleware(HttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post(
			"updateInstantRecordingProgress",
			ExtensionApiPaths.updateInstantRecordingProgress,
			{
				payload: ExtensionUploadProgressUpdateInput,
				success: Schema.Struct({ success: Schema.Boolean }),
				error: [InternalServerError, Video.NotFoundError, PolicyDeniedError],
			},
		).middleware(HttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.delete(
			"deleteInstantRecording",
			`${INSTANT_RECORDINGS_PATH}/:videoId`,
			{
				params: Schema.Struct({ videoId: Video.VideoId }),
				success: Schema.Struct({ success: Schema.Boolean }),
				error: [InternalServerError, Video.NotFoundError, PolicyDeniedError],
			},
		).middleware(HttpAuthMiddleware),
	)
	.annotateMerge(
		OpenApi.annotations({
			title: "Chrome Extension",
			description: "Endpoints used by the first-party Cap Chrome recorder.",
		}),
	) {}
