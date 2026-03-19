import type { videos } from "@cap/database/schema";
import type { ImageUpload, Organisation, User } from "@cap/web-domain";
import type { OrganizationSettings } from "@/app/(org)/dashboard/dashboard-data";

export type VideoData = Omit<typeof videos.$inferSelect, "ownerId"> & {
	owner: VideoOwner;
	organizationMembers?: User.UserId[];
	organizationId?: Organisation.OrganisationId;
	sharedOrganizations?: { id: string; name: string }[];
	hasPassword?: boolean;
	orgSettings?: OrganizationSettings | null;
};

export type VideoOwner = {
	id: User.UserId;
	isPro: boolean;
	name?: string | null;
	image?: ImageUpload.ImageUrl | null;
};
