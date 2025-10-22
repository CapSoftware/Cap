import { Rpc, RpcGroup } from "@effect/rpc";
import { Schema } from "effect";

import { RpcAuthMiddleware } from "./Authentication.ts";
import { InternalError } from "./Errors.ts";
import { OrganisationId } from "./Organisation.ts";

export const UserId = Schema.String.pipe(Schema.brand("UserId"));
export type UserId = typeof UserId.Type;

export const OnboardingStepPayload = Schema.Union(
	Schema.Struct({
		step: Schema.Literal("welcome"),
		data: Schema.Struct({
			firstName: Schema.String,
			lastName: Schema.optional(Schema.String),
		}),
	}),
	Schema.Struct({
		step: Schema.Literal("organizationSetup"),
		data: Schema.Struct({
			organizationName: Schema.String,
			organizationIcon: Schema.optional(
				Schema.Struct({
					data: Schema.Uint8Array,
					contentType: Schema.String,
					fileName: Schema.String,
				}),
			),
		}),
	}),
	Schema.Struct({
		step: Schema.Literal("customDomain"),
		data: Schema.Void,
	}),
	Schema.Struct({
		step: Schema.Literal("inviteTeam"),
		data: Schema.Void,
	}),
	Schema.Struct({
		step: Schema.Literal("skipToDashboard"),
		data: Schema.Void,
	}),
);

export const OnboardingStepResult = Schema.Union(
	Schema.Struct({
		step: Schema.Literal("welcome"),
		data: Schema.Void,
	}),
	Schema.Struct({
		step: Schema.Literal("organizationSetup"),
		data: Schema.Struct({
			organizationId: OrganisationId,
		}),
	}),
	Schema.Struct({
		step: Schema.Literal("customDomain"),
		data: Schema.Void,
	}),
	Schema.Struct({
		step: Schema.Literal("inviteTeam"),
		data: Schema.Void,
	}),
	Schema.Struct({
		step: Schema.Literal("skipToDashboard"),
		data: Schema.Void,
	}),
);

export const GetSignedImageUrlPayload = Schema.Struct({
	key: Schema.String,
	type: Schema.Literal("user", "organization"),
});

export const GetSignedImageUrlResult = Schema.Struct({
	url: Schema.String,
});

export const UploadImagePayload = Schema.Struct({
	data: Schema.Uint8Array,
	contentType: Schema.String,
	fileName: Schema.String,
	type: Schema.Literal("user", "organization"),
	entityId: Schema.String,
	oldImageKey: Schema.optional(Schema.NullOr(Schema.String)),
});

export const UploadImageResult = Schema.Struct({
	key: Schema.String,
});

export const RemoveImagePayload = Schema.Struct({
	imageKey: Schema.String,
	type: Schema.Literal("user", "organization"),
	entityId: Schema.String,
});

export const RemoveImageResult = Schema.Struct({
	success: Schema.Literal(true),
});

export class UserRpcs extends RpcGroup.make(
	Rpc.make("UserCompleteOnboardingStep", {
		payload: OnboardingStepPayload,
		success: OnboardingStepResult,
		error: InternalError,
	}).middleware(RpcAuthMiddleware),
	Rpc.make("GetSignedImageUrl", {
		payload: GetSignedImageUrlPayload,
		success: GetSignedImageUrlResult,
		error: InternalError,
	}).middleware(RpcAuthMiddleware),
	Rpc.make("UploadImage", {
		payload: UploadImagePayload,
		success: UploadImageResult,
		error: InternalError,
	}).middleware(RpcAuthMiddleware),
	Rpc.make("RemoveImage", {
		payload: RemoveImagePayload,
		success: RemoveImageResult,
		error: InternalError,
	}).middleware(RpcAuthMiddleware),
) {}
