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
	user: MaybePromise<{ id: string } | undefined | null>,
	video: Pick<
		InferSelectModel<typeof videos>,
		"public" | "password" | "ownerId"
	>,
): Promise<"has-access" | "private" | "needs-password" | "not-org-email"> {
	if (video.public && video.password === null) return "has-access";

	const _user = await user;
	if (video.public === false && (!_user || _user.id !== video.ownerId))
		return "private";

	if (video.password === null) return "has-access";

	if (!(await verifyPasswordCookie(video.password))) return "needs-password";
	return "has-access";
}
