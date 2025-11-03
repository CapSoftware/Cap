import * as Db from "@cap/database/schema";
import { CurrentUser, Organisation, Policy } from "@cap/web-domain";
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

			const deleteOrg = Effect.fn("Organisations.deleteOrg")(function* (
				id: Organisation.OrganisationId,
			) {
				const user = yield* CurrentUser;

				yield* Policy.withPolicy(policy.isOwner(id))(Effect.void);

				//this is fake deleting for now
				yield* db.use((db) =>
					db
						.update(Db.organizations)
						.set({ tombstoneAt: new Date() })
						.where(Dz.eq(Db.organizations.id, id)),
				);

				//set another org as active org
				const [otherOrg] = yield* db.use((db) =>
					db
						.select({ id: Db.organizations.id })
						.from(Db.organizations)
						.where(
							Dz.and(
								Dz.ne(Db.organizations.id, id),
								Dz.isNull(Db.organizations.tombstoneAt),
								Dz.eq(Db.organizations.ownerId, user.id),
							),
						)
						.orderBy(Dz.asc(Db.organizations.createdAt))
						.limit(1),
				);
				if (otherOrg) {
					yield* db.use((db) =>
						db
							.update(Db.users)
							.set({
								activeOrganizationId: otherOrg.id,
								defaultOrgId: otherOrg.id,
							})
							.where(Dz.eq(Db.users.id, user.id)),
					);
				}
			});
			return { update, deleteOrg };
		}),
		dependencies: [
			ImageUploads.Default,
			S3Buckets.Default,
			Database.Default,
			OrganisationsPolicy.Default,
		],
	},
) {}
