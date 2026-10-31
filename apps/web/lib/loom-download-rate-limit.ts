import { getCurrentUser } from "@cap/database/auth/session";
import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";

export const LOOM_DOWNLOAD_RATE_LIMITED_MESSAGE =
	"Too many download requests. Please wait a minute and try again.";

export async function isLoomDownloadRateLimited(headers?: Headers) {
	const user = await getCurrentUser().catch(() => null);
	return isRateLimited(RATE_LIMIT_IDS.LOOM_DOWNLOAD, {
		...(user ? { key: `loom-download:${user.id}` } : {}),
		...(headers ? { headers } : {}),
	});
}
