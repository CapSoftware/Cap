import { serverEnv } from "@cap/env";
import type { Organisation, User, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { nanoId } from "./helpers.ts";
import { db } from "./index.ts";
import { organizations, type sharedVideos } from "./schema.ts";

export type NewVideoSharingDefaults = {
	public: boolean;
	sharedWithOrganization: boolean;
};

export async function getNewVideoSharingDefaults(
	organizationId: Organisation.OrganisationId,
): Promise<NewVideoSharingDefaults> {
	const [organization] = await db()
		.select({
			defaultVideoVisibility: organizations.defaultVideoVisibility,
			settings: organizations.settings,
			tombstoneAt: organizations.tombstoneAt,
		})
		.from(organizations)
		.where(eq(organizations.id, organizationId))
		.limit(1);

	if (!organization || organization.tombstoneAt) {
		throw new Error("Organization not found");
	}

	return {
		public:
			organization.defaultVideoVisibility === "private"
				? false
				: serverEnv().CAP_VIDEOS_DEFAULT_PUBLIC,
		sharedWithOrganization:
			organization.settings?.shareNewVideosWithOrganization === true,
	};
}

export async function getNewVideoPublic(
	organizationId: Organisation.OrganisationId,
): Promise<boolean> {
	return (await getNewVideoSharingDefaults(organizationId)).public;
}

export const newVideoOrganizationShare = ({
	videoId,
	organizationId,
	sharedByUserId,
}: {
	videoId: Video.VideoId;
	organizationId: Organisation.OrganisationId;
	sharedByUserId: User.UserId;
}): typeof sharedVideos.$inferInsert => ({
	id: nanoId(),
	videoId,
	organizationId,
	sharedByUserId,
});
