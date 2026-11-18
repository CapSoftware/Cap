"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	organizations,
	sharedVideos,
	spaces,
	videos,
} from "@cap/database/schema";
import type { Organisation, Space, Video } from "@cap/web-domain";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { getOrganizationAccess } from "@/actions/organization/authorization";
import { getSpaceAccess } from "@/actions/organization/space-authorization";
import { canManageOrganizationMembers } from "@/lib/permissions/roles";
import {
	MAX_SELECT_ALL_ITEMS,
	type SelectAllView,
} from "@/lib/select-all-view";
import { spaceVideoOrderFromSettings } from "@/lib/space-video-order";
import { getSpaceRootVideoOrder } from "@/lib/space-video-order-query";

const capped = (ids: Video.VideoId[]) => ({
	ids: ids.slice(0, MAX_SELECT_ALL_ITEMS),
	truncated: ids.length > MAX_SELECT_ALL_ITEMS,
});

export async function listCapIdsInView(
	view: SelectAllView,
): Promise<{ ids: Video.VideoId[]; truncated: boolean }> {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	if (view.type === "personal" || view.type === "archived") {
		if (!user.activeOrganizationId) return { ids: [], truncated: false };
		const isArchivedView = view.type === "archived";
		const rows = await db()
			.select({ id: videos.id })
			.from(videos)
			.innerJoin(organizations, eq(videos.orgId, organizations.id))
			.where(
				and(
					eq(videos.ownerId, user.id),
					eq(videos.orgId, user.activeOrganizationId),
					isNull(organizations.tombstoneAt),
					isArchivedView
						? isNotNull(videos.archivedAt)
						: and(isNull(videos.folderId), isNull(videos.archivedAt)),
				),
			)
			.orderBy(
				...(isArchivedView
					? [desc(videos.archivedAt), desc(videos.id)]
					: [desc(videos.effectiveCreatedAt), desc(videos.id)]),
			)
			.limit(MAX_SELECT_ALL_ITEMS + 1);
		return capped(rows.map((row) => row.id));
	}

	if (view.type === "space") {
		const access = await getSpaceAccess(user.id, view.spaceId as Space.SpaceId);
		if (!access?.canManage) throw new Error("Forbidden");
		const [space] = await db()
			.select({ settings: spaces.settings })
			.from(spaces)
			.where(eq(spaces.id, access.spaceId))
			.limit(1);
		const rows = await getSpaceRootVideoOrder(
			access.spaceId,
			spaceVideoOrderFromSettings(space?.settings),
			{ limit: MAX_SELECT_ALL_ITEMS + 1 },
		);
		return capped(rows.map((row) => row.id));
	}

	const access = await getOrganizationAccess(
		user.id,
		view.organizationId as Organisation.OrganisationId,
	);
	if (!access || !canManageOrganizationMembers(access.role))
		throw new Error("Forbidden");
	const rows = await db()
		.selectDistinct({
			id: videos.id,
			effectiveCreatedAt: videos.effectiveCreatedAt,
		})
		.from(sharedVideos)
		.innerJoin(videos, eq(sharedVideos.videoId, videos.id))
		.where(
			and(
				eq(sharedVideos.organizationId, access.id),
				isNull(sharedVideos.folderId),
			),
		)
		.orderBy(desc(videos.effectiveCreatedAt), desc(videos.id))
		.limit(MAX_SELECT_ALL_ITEMS + 1);
	return capped(rows.map((row) => row.id));
}
