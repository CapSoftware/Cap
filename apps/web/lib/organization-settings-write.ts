import { organizations } from "@cap/database/schema";
import { sql } from "drizzle-orm";

type OrganizationSettings = NonNullable<
	(typeof organizations.$inferSelect)["settings"]
>;

// allowPublicLinkOverride gates access to restricted links, and
// defaultCallToAction and shareNewVideosWithOrganization have their own
// editors, so a settings write built from an earlier read must not put a stale
// value back for any of them. These keys are taken from the row at write time
// instead.
export const organizationSettingsKeepingRowOwnedKeys = (
	next: OrganizationSettings,
) => {
	const {
		allowPublicLinkOverride: _staleOverride,
		defaultCallToAction: _staleCallToAction,
		shareNewVideosWithOrganization: _staleShareNewVideos,
		...rest
	} = next;
	return sql`JSON_MERGE_PATCH(CAST(${JSON.stringify(rest)} AS JSON), JSON_OBJECT('allowPublicLinkOverride', JSON_EXTRACT(${organizations.settings}, '$.allowPublicLinkOverride'), 'defaultCallToAction', JSON_EXTRACT(${organizations.settings}, '$.defaultCallToAction'), 'shareNewVideosWithOrganization', JSON_EXTRACT(${organizations.settings}, '$.shareNewVideosWithOrganization')))`;
};
