import path from "node:path";
import { db } from "@cap/database";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { runSpaceMemberRoleBackfill } from "./migrations/space_member_role_backfill.ts";

export async function migrateDb() {
	await migrate(db(), {
		migrationsFolder: path.join(process.cwd(), "/migrations"),
	});

	await runSpaceMemberRoleBackfill();
}
