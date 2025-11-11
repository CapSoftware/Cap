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

export type ShareAnalyticsContext = {
	city?: string | null;
	country?: string | null;
	referrer?: string | null;
	referrerUrl?: string | null;
	utmSource?: string | null;
	utmMedium?: string | null;
	utmCampaign?: string | null;
	utmTerm?: string | null;
	utmContent?: string | null;
	userAgent?: string | null;
};
