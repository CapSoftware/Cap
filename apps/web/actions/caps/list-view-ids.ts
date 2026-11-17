"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	organizations,
	sharedVideos,
	spaceVideos,
	videos,
} from "@cap/database/schema";
import type { Organisation, Space, Video } from "@cap/web-domain";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { getOrganizationAccess } from "@/actions/organization/authorization";
import { getSpaceAccess } from "@/actions/organization/space-authorization";
import { canManageOrganizationMembers } from "@/lib/permissions/roles";
import {
	MAX_SELECT_ALL_ITEMS,
	type SelectAllView,
} from "@/lib/select-all-view";

const capped = (ids: Video.VideoId[]) => ({
	ids: ids.slice(0, MAX_SELECT_ALL_ITEMS),
	truncated: ids.length > MAX_SELECT_ALL_ITEMS,
});

// Returns the ids behind "Select all N" for the exact list the page shows, so a
// bulk action can run past the current page. The same filters as the page
// queries apply, and shared lists require the same rights that let the page
// show selection at all.
export async function listCapIdsInView(
	view: SelectAllView,
): Promise<{ ids: Video.VideoId[]; truncated: boolean }> {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	if (view.type === "personal" || view.type === "archived") {
		if (!user.activeOrganizationId) return { ids: [], truncated: false };
		const rows = await db()
			.select({ id: videos.id })
			.from(videos)
			.innerJoin(organizations, eq(videos.orgId, organizations.id))
			.where(
				and(
					eq(videos.ownerId, user.id),
					eq(videos.orgId, user.activeOrganizationId),
					isNull(organizations.tombstoneAt),
					view.type === "personal"
						? and(isNull(videos.folderId), isNull(videos.archivedAt))
						: isNotNull(videos.archivedAt),
				),
			)
			.limit(MAX_SELECT_ALL_ITEMS + 1);
		return capped(rows.map((row) => row.id));
	}

	if (view.type === "space") {
		const access = await getSpaceAccess(user.id, view.spaceId as Space.SpaceId);
		if (!access?.canManage) throw new Error("Forbidden");
		const rows = await db()
			.selectDistinct({ id: videos.id })
			.from(spaceVideos)
			.innerJoin(videos, eq(spaceVideos.videoId, videos.id))
			.leftJoin(organizations, eq(videos.orgId, organizations.id))
			.where(
				and(
					eq(spaceVideos.spaceId, access.spaceId),
					isNull(spaceVideos.folderId),
					isNull(organizations.tombstoneAt),
				),
			)
			.limit(MAX_SELECT_ALL_ITEMS + 1);
		return capped(rows.map((row) => row.id));
	}

	const access = await getOrganizationAccess(
		user.id,
		view.organizationId as Organisation.OrganisationId,
	);
	if (!access || !canManageOrganizationMembers(access.role))
		throw new Error("Forbidden");
	const rows = await db()
		.selectDistinct({ id: videos.id })
		.from(sharedVideos)
		.innerJoin(videos, eq(sharedVideos.videoId, videos.id))
		.where(
			and(
				eq(sharedVideos.organizationId, access.id),
				isNull(sharedVideos.folderId),
			),
		)
		.limit(MAX_SELECT_ALL_ITEMS + 1);
	return capped(rows.map((row) => row.id));
}
