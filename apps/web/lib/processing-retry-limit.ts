import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";

export const PROCESSING_RETRY_RATE_MESSAGE =
	"Too many processing retries. Try again in an hour.";

export function processingRetryLimited(userId: string, headers?: Headers) {
	return isRateLimited(RATE_LIMIT_IDS.PROCESSING_RETRY, {
		key: `processing-retry:${userId}`,
		...(headers ? { headers } : {}),
	});
}
