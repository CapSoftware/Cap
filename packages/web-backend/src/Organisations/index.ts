import * as Db from "@cap/database/schema";
import { type ImageUpload, Organisation, Policy } from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Array, Effect, Option } from "effect";

import { Database } from "../Database";
import { ImageUploads } from "../ImageUploads";
import { S3Buckets } from "../S3Buckets";
import { OrganisationsPolicy } from "./OrganisationsPolicy";

export class Organisations extends Effect.Service<Organisations>()(
	"Organisations",
	{
		effect: Effect.gen(function* () {
			const db = yield* Database;
			const policy = yield* OrganisationsPolicy;
			const imageUploads = yield* ImageUploads;

			const update = Effect.fn("Organisations.update")(function* (
				payload: Organisation.OrganisationUpdate,
			) {
				const organisation = yield* db
					.use((db) =>
						db
							.select()
							.from(Db.organizations)
							.where(Dz.eq(Db.organizations.id, payload.id)),
					)
					.pipe(
						Effect.flatMap(Array.get(0)),
						Effect.catchTag(
							"NoSuchElementException",
							() => new Organisation.NotFoundError(),
						),
						Policy.withPolicy(policy.isOwner(payload.id)),
					);

				if (payload.image) {
					yield* imageUploads.applyUpdate({
						payload: payload.image,
						existing: Option.fromNullable(organisation.iconUrl),
						keyPrefix: `organizations/${organisation.id}`,
						update: (db, urlOrKey) =>
							db
								.update(Db.organizations)
								.set({ iconUrl: urlOrKey })
								.where(Dz.eq(Db.organizations.id, organisation.id)),
					});
				}
			});

			return { update };
		}),
		dependencies: [
			ImageUploads.Default,
			S3Buckets.Default,
			Database.Default,
			OrganisationsPolicy.Default,
		],
	},
) {}
