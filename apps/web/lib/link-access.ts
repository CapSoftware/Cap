import { videos } from "@cap/database/schema";
import { sql } from "drizzle-orm";

export type LinkAccessChoice = "anyone" | "restricted";

export const resolveLinkAccessWrite = (
	isPublic: boolean | undefined,
	linkAccess: LinkAccessChoice | undefined,
): "anyone" | null | undefined =>
	isPublic === false
		? null
		: linkAccess === "anyone"
			? "anyone"
			: linkAccess === "restricted"
				? null
				: undefined;

export const linkAccessSettingsPatch = (linkAccess: "anyone" | null) =>
	sql`JSON_MERGE_PATCH(COALESCE(${videos.settings}, JSON_OBJECT()), CAST(${JSON.stringify({ linkAccess })} AS JSON))`;

export const describeLinkAccessChoice = ({
	isPublic,
	allowedEmailDomain,
	videoSettings,
	organizationSettings,
}: {
	isPublic: boolean;
	allowedEmailDomain: string | null | undefined;
	videoSettings: { linkAccess?: string } | null | undefined;
	organizationSettings:
		| { allowPublicLinkOverride?: boolean }
		| null
		| undefined;
}): LinkAccessChoice | undefined => {
	if (!isPublic) return undefined;
	if (!allowedEmailDomain?.trim()) return undefined;
	if (organizationSettings?.allowPublicLinkOverride !== true) return undefined;
	return videoSettings?.linkAccess === "anyone" ? "anyone" : "restricted";
};
