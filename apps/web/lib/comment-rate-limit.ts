import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";

export const COMMENT_RATE_LIMITED_MESSAGE =
	"Too many comments. Please wait a moment and try again.";

export const isCommentRateLimited = (userId: string) =>
	isRateLimited(RATE_LIMIT_IDS.COMMENT_CREATE, {
		key: `comment:user:${userId}`,
	});
