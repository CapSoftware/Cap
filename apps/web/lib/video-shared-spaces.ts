import { db } from "@cap/database";
import {
	organizations,
	sharedVideos,
	spaces,
	spaceVideos,
} from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq, sql } from "drizzle-orm";
import type { OrganizationSettings } from "@/app/(org)/dashboard/dashboard-data";

/** The spaces and organizations a video is shared with. */
export async function getSharedSpacesForVideo(videoId: Video.VideoId) {
	// Space-level and organization-level sharing are independent queries.
	const [spaceSharing, orgSharing] = await Promise.all([
		db()
			.select({
				id: spaces.id,
				name: spaces.name,
				organizationId: spaces.organizationId,
				iconUrl: spaces.iconUrl,
				settings: spaces.settings,
				hasPassword: sql`${spaces.password} IS NOT NULL`.mapWith(Boolean),
			})
			.from(spaceVideos)
			.innerJoin(spaces, eq(spaceVideos.spaceId, spaces.id))
			.innerJoin(organizations, eq(spaces.organizationId, organizations.id))
			.where(eq(spaceVideos.videoId, videoId)),
		db()
			.select({
				id: organizations.id,
				name: organizations.name,
				organizationId: organizations.id,
				iconUrl: organizations.iconUrl,
			})
			.from(sharedVideos)
			.innerJoin(
				organizations,
				eq(sharedVideos.organizationId, organizations.id),
			)
			.where(eq(sharedVideos.videoId, videoId)),
	]);

	const sharedSpaces: Array<{
		id: string;
		name: string;
		organizationId: string;
		iconUrl?: string;
		settings?: OrganizationSettings | null;
		hasPassword?: boolean;
	}> = [];

	// Add space-level sharing
	spaceSharing.forEach((space) => {
		sharedSpaces.push({
			id: space.id,
			name: space.name,
			organizationId: space.organizationId,
			iconUrl: space.iconUrl || undefined,
			settings: space.settings,
			hasPassword: space.hasPassword,
		});
	});

	// Add organization-level sharing
	orgSharing.forEach((org) => {
		sharedSpaces.push({
			id: org.id,
			name: org.name,
			organizationId: org.organizationId,
			iconUrl: org.iconUrl || undefined,
			settings: null,
			hasPassword: false,
		});
	});

	return {
		sharedSpaces,
		sharedOrganizations: orgSharing.map(({ id, name }) => ({ id, name })),
	};
}
