import { z } from "zod";

export function isEmailAllowedForSignup(
	email: string,
	allowedDomainsConfig?: string,
): boolean {
	// If no domain restrictions are configured, allow all signups
	if (!allowedDomainsConfig || allowedDomainsConfig.trim() === "") {
		return true;
	}

	const emailDomain = extractDomainFromEmail(email);
	if (!emailDomain) {
		return false;
	}

	const allowedDomains = parseAllowedDomains(allowedDomainsConfig);
	return allowedDomains.includes(emailDomain.toLowerCase());
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
