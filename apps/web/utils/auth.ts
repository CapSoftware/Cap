import { decrypt } from "@cap/database/crypto";
import type { videos } from "@cap/database/schema";
import type { InferSelectModel } from "drizzle-orm";
import { cookies } from "next/headers";

async function verifyPasswordCookie(videoPassword: string) {
	const password = cookies().get("x-cap-password")?.value;
	if (!password) return false;

	const decrypted = await decrypt(password).catch(() => "");
	return decrypted === videoPassword;
}

export async function userHasAccessToVideo(
	user: MaybePromise<
		{ id: string; activeOrganizationId: string } | undefined | null
	>,
	video: Pick<
		InferSelectModel<typeof videos>,
		"public" | "password" | "ownerId"
	> & {
		spaceId: string | null;
		sharedOrganization: null | { organizationId: string | null };
	},
	isSpaceMember?: boolean,
): Promise<"has-access" | "private" | "needs-password" | "not-org-email"> {
	if (video.public && video.password === null) return "has-access";

	const _user = await user;
	const videoOrgId = video.sharedOrganization?.organizationId;
	const userActiveOrgId = _user?.activeOrganizationId;

	// If the video is shared and has no space id, it's in the "All spaces" entry
	const isVideoSharedWithAllSpaces = videoOrgId && video.spaceId === null;
	if (
		!isSpaceMember &&
		userActiveOrgId === videoOrgId &&
		isVideoSharedWithAllSpaces
	) {
		return "has-access";
	}

	// If the video is shared and has a space id, it's in a specific space
	const isVideoSharedWithSpace = videoOrgId && video.spaceId;
	if (
		isSpaceMember &&
		userActiveOrgId === videoOrgId &&
		isVideoSharedWithSpace
	) {
		return "has-access";
	}

	if (video.public === false && (!_user || _user.id !== video.ownerId)) {
		return "private";
	}

	if (video.password === null) return "has-access";

	if (!(await verifyPasswordCookie(video.password))) return "needs-password";

	return "has-access";
}
