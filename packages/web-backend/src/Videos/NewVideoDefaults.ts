import * as Db from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import type { Organisation } from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import type { DbClient } from "../Database.ts";

export type NewVideoDefaults = {
	public: boolean;
	password: string | null;
};

export async function resolveNewVideoDefaults(
	db: DbClient,
	orgId: Organisation.OrganisationId,
): Promise<NewVideoDefaults> {
	const [organization] = await db
		.select({
			settings: Db.organizations.settings,
			defaultVideoPassword: Db.organizations.defaultVideoPassword,
		})
		.from(Db.organizations)
		.where(Dz.eq(Db.organizations.id, orgId));

	return {
		public:
			organization?.settings?.defaultVideoPublic ??
			serverEnv().CAP_VIDEOS_DEFAULT_PUBLIC,
		password: organization?.defaultVideoPassword ?? null,
	};
}
