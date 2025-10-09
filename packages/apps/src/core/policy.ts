import { type Organisation, Policy } from "@cap/web-domain";
import { HttpApiError } from "@effect/platform";
import { Effect } from "effect";

import type { OrganisationsPolicyInstance } from "./types.ts";

const isPolicyDeniedError = (
	error: unknown,
): error is Policy.PolicyDeniedError =>
	error instanceof Policy.PolicyDeniedError;

export const ensureOrganisationOwner = <
	PolicyInstance extends OrganisationsPolicyInstance,
>(
	policy: PolicyInstance,
	organisationId: string,
) =>
	policy
		.isOwner(organisationId as Organisation.OrganisationId)
		.pipe(
			Effect.catchIf(isPolicyDeniedError, () =>
				Effect.fail(new HttpApiError.Forbidden()),
			),
		);

export const ensureOrganisationMember = <
	PolicyInstance extends OrganisationsPolicyInstance,
>(
	policy: PolicyInstance,
	organisationId: string,
) =>
	policy
		.isMember(organisationId as Organisation.OrganisationId)
		.pipe(
			Effect.catchIf(isPolicyDeniedError, () =>
				Effect.fail(new HttpApiError.Forbidden()),
			),
		);

export { isPolicyDeniedError };
