import { InternalError, Organisation } from "@cap/web-domain";
import { Effect } from "effect";
import { Organisations } from ".";

export const OrganisationsRpcsLive = Organisation.OrganisationRpcs.toLayer(
	Effect.gen(function* () {
		const orgs = yield* Organisations;

		return {
			OrganisationUpdate: (data) =>
				orgs.update(data).pipe(
					Effect.catchTags({
						DatabaseError: () => new InternalError({ type: "database" }),
						S3Error: () => new InternalError({ type: "s3" }),
					}),
				),
			OrganisationDelete: (data) =>
				orgs.deleteOrg(data.id).pipe(
					Effect.catchTags({
						DatabaseError: () => new InternalError({ type: "database" }),
					}),
				),
		};
	}),
);
