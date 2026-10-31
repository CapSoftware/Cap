import { serverEnv } from "@cap/env";
import { z } from "zod";

export function normalizeEmailAddress(email: string): string {
	return email.normalize("NFKC").trim().toLowerCase();
}

/**
 * The email provider's identifier for an email sign-in. next-auth stores,
 * emails and looks up accounts by this value, and the OTP rate limits key on it.
 */
export function normalizeSignInEmail(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.normalize("NFKC").trim();
	if (trimmed.split("@").length !== 2 || trimmed.includes('"')) return null;
	const [local, domain] = trimmed.toLowerCase().split("@");
	const host = domain?.split(",")[0];
	if (!local || !host || !host.includes(".")) return null;
	return `${local}@${host}`;
}

export function isEmailAllowedForSignup(
	email: string,
	allowedDomainsConfig?: string,
): boolean {
	// If no domain restrictions are configured, allow all signups
	if (!allowedDomainsConfig || allowedDomainsConfig.trim() === "") {
		return true;
	}

	const emailDomain = extractDomainFromEmail(normalizeEmailAddress(email));
	if (!emailDomain) {
		return false;
	}

	const allowedDomains = parseAllowedDomains(allowedDomainsConfig);
	return allowedDomains.includes(emailDomain.toLowerCase());
}

/**
 * Whether an account email is refused everywhere: sign-in, existing sessions,
 * and API keys. Reads CAP_BLOCKED_SIGNUP_DOMAINS.
 */
export function isBlockedAccountEmail(
	email: string | null | undefined,
): boolean {
	if (!email) return false;
	return isEmailBlockedFromSignup(
		email,
		serverEnv().CAP_BLOCKED_SIGNUP_DOMAINS,
	);
}

/**
 * Whether an email is refused at sign-in. Entries are domains ("example.com")
 * or full addresses ("someone@example.com"), comma-separated. Unlike the
 * allowlist this applies to existing users too, so a blocked account cannot
 * sign back in after it has been removed.
 */
export function isEmailBlockedFromSignup(
	email: string,
	blockedConfig?: string,
): boolean {
	if (!blockedConfig || blockedConfig.trim() === "") return false;
	const normalized = normalizeEmailAddress(email);
	const emailDomain = extractDomainFromEmail(normalized);
	if (!emailDomain) return false;
	for (const raw of blockedConfig.split(",")) {
		const entry = raw.trim().toLowerCase();
		if (!entry) continue;
		if (entry.includes("@")) {
			if (entry === normalized) return true;
		} else if (isValidDomain(entry) && entry === emailDomain.toLowerCase()) {
			return true;
		}
	}
	return false;
}

function extractDomainFromEmail(email: string): string | null {
	// TODO: replace with zod v4's z.email()
	const emailValidation = z.string().email().safeParse(email);
	if (!emailValidation.success) {
		return null;
	}

	// Extract domain from validated email
	const atIndex = email.lastIndexOf("@");
	return atIndex !== -1 ? email.substring(atIndex + 1) : null;
}

function parseAllowedDomains(allowedDomainsConfig: string): string[] {
	return allowedDomainsConfig
		.split(",")
		.map((domain) => domain.trim().toLowerCase())
		.filter((domain) => domain.length > 0 && isValidDomain(domain));
}

function isValidDomain(domain: string): boolean {
	// TODO: replace this polyfill with zod v4's z.hostname()
	const hostnameRegex =
		/^(?=.{1,253}$)(^((?!-)[a-zA-Z0-9-]{1,63}(?<!-)\.)+[a-zA-Z]{2,63}$|localhost)$/;
	return z
		.string()
		.refine((val) => hostnameRegex.test(val), {
			message: "Invalid hostname",
		})
		.safeParse(domain).success;
}
