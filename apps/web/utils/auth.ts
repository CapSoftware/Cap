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
		sharedOrganization: null | {
			organizationId: string | null;
		};
		isSpaceMember: null | string;
	},
): Promise<"has-access" | "private" | "needs-password" | "not-org-email"> {
	// Public videos with no password are always accessible
	if (video.public && video.password === null) return "has-access";

	const _user = await user;

	// Owner always has access (regardless of space membership)
	if (_user && _user.id === video.ownerId) {
		if (video.password === null) return "has-access";
		if (await verifyPasswordCookie(video.password)) return "has-access";
		return "needs-password";
	}

	const videoOrgId = video.sharedOrganization?.organizationId;
	const userActiveOrgId = _user?.activeOrganizationId;

	// Check organization-level access
	if (videoOrgId && userActiveOrgId === videoOrgId) {
		// Video shared with "All spaces" (no specific space requirement)
		if (video.spaceId === null) {
			if (video.password === null) return "has-access";
			if (await verifyPasswordCookie(video.password)) return "has-access";
			return "needs-password";
		}

		// Video shared with specific space (user must be space member)
		if (video.spaceId && video.isSpaceMember) {
			if (video.password === null) return "has-access";
			if (await verifyPasswordCookie(video.password)) return "has-access";
			return "needs-password";
		}
	}

	// Public videos with password
	if (video.public && video.password) {
		if (await verifyPasswordCookie(video.password)) return "has-access";
		return "needs-password";
	}

	// No access
	return "private";
}
