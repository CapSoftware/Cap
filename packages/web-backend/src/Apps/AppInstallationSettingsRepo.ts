import { nanoId } from "@cap/database/helpers";
import * as Db from "@cap/database/schema";
import * as Dz from "drizzle-orm";
import { Array, Effect } from "effect";

import { Database } from "../Database.ts";

export type AppInstallationSettingsRow = typeof Db.appInstallationSettings.$inferSelect;

export class AppInstallationSettingsRepo extends Effect.Service<
	AppInstallationSettingsRepo
>()("AppInstallationSettingsRepo", {
	effect: Effect.gen(function* () {
		const database = yield* Database;

		const findByInstallationId = (installationId: string) =>
			database
				.execute((db) =>
					db
						.select()
						.from(Db.appInstallationSettings)
						.where(
							Dz.eq(
								Db.appInstallationSettings.installationId,
								installationId,
							),
						),
				)
				.pipe(Effect.map(Array.get(0)));

		const upsert = (installationId: string, settings: Record<string, unknown>) =>
			database.execute(async (db) => {
				await db
					.insert(Db.appInstallationSettings)
					.values({
						id: nanoId(),
						installationId,
						settings,
					})
					.onDuplicateKeyUpdate({
						set: {
							settings,
						},
					});
			});

		const deleteByInstallationId = (installationId: string) =>
			database.execute((db) =>
				db
					.delete(Db.appInstallationSettings)
					.where(
						Dz.eq(
							Db.appInstallationSettings.installationId,
							installationId,
						),
					));

		return { findByInstallationId, upsert, deleteByInstallationId };
	}),
	dependencies: [Database.Default],
}) {}
