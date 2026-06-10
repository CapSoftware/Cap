import type { videos } from "@cap/database/schema";
import type { SpaceRuleSource, ViewerSettingKey } from "@cap/web-backend";
import type { ImageUpload, Organisation, User } from "@cap/web-domain";
import type { OrganizationSettings } from "@/app/(org)/dashboard/dashboard-data";

export type VideoData = Omit<typeof videos.$inferSelect, "ownerId"> & {
	owner: VideoOwner;
	organizationMembers?: User.UserId[];
	organizationId?: Organisation.OrganisationId;
	sharedOrganizations?: { id: string; name: string }[];
	hasPassword?: boolean;
	hasInheritedPassword?: boolean;
	inheritedPasswordSources?: SpaceRuleSource[];
	inheritedSpaceSettings?: Partial<Record<ViewerSettingKey, SpaceRuleSource[]>>;
	orgSettings?: OrganizationSettings | null;
	organizationName?: string | null;
	organizationIconUrl?: ImageUpload.ImageUrl | null;
	shareableLinkIconUrl?: ImageUpload.ImageUrl | null;
	hasActiveUpload?: boolean;
	activeUploadRawFileKey?: string | null;
};

export type VideoOwner = {
	id: User.UserId;
	isPro: boolean;
	name?: string | null;
	image?: ImageUpload.ImageUrl | null;
};

export type { SharePageBranding } from "@/lib/share-branding";
