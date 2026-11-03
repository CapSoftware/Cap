import crypto from "node:crypto";
import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";

export function normalizeSignInEmail(value: unknown) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (trimmed.split("@").length !== 2 || trimmed.includes('"')) return null;
	const [local, domain] = trimmed.toLowerCase().split("@");
	const host = domain?.split(",")[0];
	if (!local || !host || !host.includes(".")) return null;
	return `${local}@${host}`;
}

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
