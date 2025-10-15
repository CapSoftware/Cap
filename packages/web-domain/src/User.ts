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
		step: Schema.Literal("download"),
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
		step: Schema.Literal("download"),
		data: Schema.Void,
	}),
);

export class UserRpcs extends RpcGroup.make(
	Rpc.make("UserCompleteOnboardingStep", {
		payload: OnboardingStepPayload,
		success: OnboardingStepResult,
		error: InternalError,
	}).middleware(RpcAuthMiddleware),
) {}
