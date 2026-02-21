import path from "node:path";
import { db } from "@cap/database";
import { DrizzleQueryError } from "drizzle-orm";
import { migrate } from "drizzle-orm/mysql2/migrator";

import { runOrgIdBackfill } from "./migrations/orgid_backfill.ts";

async function runMigrate() {
	await migrate(db() as any, {
		migrationsFolder: path.join(process.cwd(), "/migrations"),
	});
}

function errorIsOrgIdMigration(e: unknown): e is DrizzleQueryError {
	return (
		e instanceof DrizzleQueryError &&
		e.query ===
			"ALTER TABLE `videos` MODIFY COLUMN `orgId` varchar(15) NOT NULL;"
	);
}

export async function migrateDb() {
	await runMigrate()
		.catch(async (e) => {
			if (errorIsOrgIdMigration(e)) {
				console.log("non-null videos.orgId migration failed, running backfill");

				await runOrgIdBackfill();
				await runMigrate();
			} else throw e;
		})
		.catch((e) => {
			if (errorIsOrgIdMigration(e))
				throw new Error(
					"videos.orgId backfill failed, you will need to manually update the videos.orgId column before attempting to migrate again.",
				);
			throw e;
		});
}
