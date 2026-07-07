import {
	DatabaseError,
	InternalError,
	Organisation,
	Policy,
	S3Error,
} from "@cap/web-domain";
import { Effect, Schema } from "effect";
import { Organisations } from ".";

const mapSoftDeleteError = (
	error: unknown,
): Organisation.NotFoundError | Policy.PolicyDeniedError | InternalError => {
	if (Schema.is(Organisation.NotFoundError)(error)) return error;
	if (Schema.is(Policy.PolicyDeniedError)(error)) return error;
	if (Schema.is(DatabaseError)(error))
		return new InternalError({ type: "database" });
	if (Schema.is(S3Error)(error)) return new InternalError({ type: "s3" });
	return new InternalError({ type: "unknown" });
};

export const OrganisationsRpcsLive = Organisation.OrganisationRpcs.toLayer(
	Effect.gen(function* () {
		const orgs = yield* Organisations;

		return {
			OrganisationUpdate: (data) =>
				orgs.update(data).pipe(
					Effect.catchTags({
						DatabaseError: () =>
							Effect.fail(new InternalError({ type: "database" })),
						S3Error: () => Effect.fail(new InternalError({ type: "s3" })),
					}),
				),
			OrganisationSoftDelete: (data) =>
				orgs
					.softDelete(data.id)
					.pipe(
						Effect.catchAll((error) => Effect.fail(mapSoftDeleteError(error))),
					),
		};
	}),
);
