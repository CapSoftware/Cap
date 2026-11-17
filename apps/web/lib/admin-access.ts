import { getCurrentUser } from "@cap/database/auth/session";
import { Video } from "@cap/web-domain";
import { MESSENGER_ADMIN_EMAIL } from "@/lib/messenger/constants";

export async function requireAdmin() {
	const user = await getCurrentUser();
	if (!user || user.email !== MESSENGER_ADMIN_EMAIL) {
		throw new Error("Unauthorized");
	}
	return user;
}

export function parseAdminVideoId(input: string) {
	const trimmed = input.trim();
	if (!trimmed) {
		throw new Error("Enter a video ID or share URL");
	}

	try {
		const url = new URL(trimmed);
		const pathMatch = url.pathname.match(/\/s\/([^/?#]+)/);
		if (pathMatch?.[1]) {
			return Video.VideoId.make(pathMatch[1]);
		}
		const lastSegment = url.pathname.split("/").filter(Boolean).at(-1);
		if (lastSegment) {
			return Video.VideoId.make(lastSegment);
		}
	} catch {}

	return Video.VideoId.make(trimmed);
}
