import { organizations } from "@cap/database/schema";
import { sql } from "drizzle-orm";

type OrganizationSettings = NonNullable<
	(typeof organizations.$inferSelect)["settings"]
>;

// allowPublicLinkOverride gates access to restricted links, so a settings
// write built from an earlier read must not put a stale value back after an
// admin turned it off. The key is taken from the row at write time instead.
export const organizationSettingsKeepingLinkOverride = (
	next: OrganizationSettings,
) => {
	const { allowPublicLinkOverride: _stale, ...rest } = next;
	return sql`JSON_MERGE_PATCH(CAST(${JSON.stringify(rest)} AS JSON), JSON_OBJECT('allowPublicLinkOverride', JSON_EXTRACT(${organizations.settings}, '$.allowPublicLinkOverride')))`;
};
