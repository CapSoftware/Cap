import { checkRateLimit } from "@vercel/firewall";
import { headers as nextHeaders } from "next/headers";

/**
 * Best-effort per-key rate limiting backed by the Vercel Firewall.
 *
 * IMPORTANT: each `ruleId` passed here must also be configured as a Rate Limit
 * rule in the Vercel Firewall dashboard (Firewall → Rate Limiting) with a
 * `@vercel/firewall` rule condition whose ID matches `ruleId`, plus the desired
 * window / limit / action. An ID that has no matching dashboard rule fails
 * OPEN (`checkRateLimit` returns `{ rateLimited: false, error: "not-found" }`),
 * so this helper never breaks self-hosted deploys that lack the firewall — but
 * it also provides no protection until the rule exists.
 *
 * Mirrors the existing pattern in `actions/collections/password.ts` and
 * `actions/send-download-link.ts`:
 *  - only enforced in production,
 *  - best-effort (any error → not limited) so a firewall/IP-header outage can
 *    never take down the underlying feature.
 *
 * @param ruleId   Stable rule id, also configured in the Vercel Firewall.
 * @param opts.key Optional bucket key (e.g. per-email / per-user). Defaults to
 *                 the caller IP (the firewall's default behaviour).
 * @param opts.headers Optional request headers (required inside Hono handlers
 *                 where `next/headers` is unavailable; defaults to the App
 *                 Router request headers).
 * @returns `true` when the request should be rejected.
 */
export async function isRateLimited(
	ruleId: string,
	opts?: { key?: string; headers?: Headers },
): Promise<boolean> {
	if (process.env.NODE_ENV !== "production") return false;

	try {
		const headersList = opts?.headers ?? (await nextHeaders());
		const request = new Request("https://cap.so/api/rate-limit", {
			method: "POST",
			headers: headersList,
		});

		const { rateLimited } = await checkRateLimit(ruleId, {
			request,
			...(opts?.key ? { rateLimitKey: opts.key } : {}),
		});

		return rateLimited;
	} catch (error) {
		console.warn(`Rate limit check failed for "${ruleId}":`, error);
		return false;
	}
}

/**
 * Canonical Vercel Firewall rate-limit rule ids introduced by the security
 * hardening pass. Each MUST be created in the Vercel Firewall dashboard for the
 * corresponding protection to take effect (see `isRateLimited`).
 */
export const RATE_LIMIT_IDS = {
	/** Email OTP verification attempts (brute-force guard). Suggested: 10 / 10m per key (email). */
	AUTH_OTP_VERIFY: "rl_auth_otp_verify",
	/** Email OTP / magic-link send (mailbomb + token-reseed guard). Suggested: 5 / 10m per key (email). */
	AUTH_OTP_SEND: "rl_auth_otp_send",
	/** Unauthed Loom download/convert (ffmpeg + memory DoS). Suggested: 10 / 1m per IP. */
	LOOM_DOWNLOAD: "rl_loom_download",
	/** Unauthed transcript translation (Groq cost). Suggested: 10 / 1m per IP. */
	TRANSLATE_TRANSCRIPT: "rl_translate_transcript",
	/** Anonymous support-chat messages (Groq + Supermemory cost). Suggested: 20 / 1m per IP. */
	MESSENGER_MESSAGE: "rl_messenger_message",
	/** Unauthed analytics view tracking (Tinybird ingest + notifications). Suggested: 60 / 1m per IP. */
	ANALYTICS_TRACK: "rl_analytics_track",
	/** Unauthed guest checkout (Stripe object/cost abuse). Suggested: 10 / 10m per IP. */
	GUEST_CHECKOUT: "rl_guest_checkout",
	/** Unauthed desktop log → Discord forwarding (spam). Suggested: 10 / 1m per IP. */
	DESKTOP_LOGS: "rl_desktop_logs",
} as const;
