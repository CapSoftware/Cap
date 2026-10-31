import crypto from "node:crypto";
import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";

// Verification rows are looked up under MySQL's accent-insensitive default
// collation, so accented spellings of an address share one bucket.
const emailCodeRateLimitKey = (scope: string, email: string) =>
	`${scope}:${crypto
		.createHash("sha256")
		.update(email.normalize("NFKD").replace(/\p{M}/gu, ""))
		.digest("hex")}`;

export const isEmailCodeSendLimited = (email: string, headers?: Headers) =>
	isRateLimited(RATE_LIMIT_IDS.AUTH_OTP_SEND, {
		key: emailCodeRateLimitKey("email-code-send", email),
		headers,
	});

export const isEmailCodeVerifyLimited = (email: string, headers?: Headers) =>
	isRateLimited(RATE_LIMIT_IDS.AUTH_OTP_VERIFY, {
		key: emailCodeRateLimitKey("email-code-verify", email),
		headers,
	});
