import { nanoId } from "@cap/database/helpers";
import * as Db from "@cap/database/schema";
import * as Dz from "drizzle-orm";
import { Array, Effect } from "effect";

import { Database } from "../Database.ts";

export type AppInstallationInsert = typeof Db.appInstallations.$inferInsert;
export type AppInstallationSelect = typeof Db.appInstallations.$inferSelect;

const stripUndefined = <T extends Record<string, unknown>>(value: T): T =>
	Object.fromEntries(
		Object.entries(value).filter(([, v]) => v !== undefined),
	) as T;

export class AppInstallationsRepo extends Effect.Service<AppInstallationsRepo>()(
	"AppInstallationsRepo",
	{
		effect: Effect.gen(function* () {
			const database = yield* Database;

			const findByOrgAndType = (organizationId: string, appType: Db.AppType) =>
				database
					.execute((db) =>
						db
							.select()
							.from(Db.appInstallations)
							.where(
								Dz.and(
									Dz.eq(Db.appInstallations.organizationId, organizationId),
									Dz.eq(Db.appInstallations.appType, appType),
								),
							),
					)
					.pipe(Effect.map(Array.get(0)));

			const create = (
				installation: Omit<
					AppInstallationInsert,
					"id" | "createdAt" | "updatedAt"
				> & { id?: string },
			) =>
				Effect.gen(function* () {
					const id = installation.id ?? nanoId();

					yield* database.execute((db) =>
						db.insert(Db.appInstallations).values({
							...stripUndefined(installation),
							id,
						}),
					);

					return id;
				});

			const updateById = (
				id: string,
				updates: Partial<
					Omit<AppInstallationInsert, "id" | "createdAt" | "updatedAt">
				>,
			) =>
				database.execute((db) =>
					db
						.update(Db.appInstallations)
						.set(stripUndefined(updates))
						.where(Dz.eq(Db.appInstallations.id, id)),
				);

			const deleteById = (id: string) =>
				database.execute((db) =>
					db
						.delete(Db.appInstallations)
						.where(Dz.eq(Db.appInstallations.id, id)),
					);

			return { findByOrgAndType, create, updateById, deleteById };
		}),
		dependencies: [Database.Default],
	},
) {}
