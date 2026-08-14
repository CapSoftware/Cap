import { db } from "@cap/database";
import { organizations } from "@cap/database/schema";
import { buildEnv } from "@cap/env";
import { eq } from "drizzle-orm";

/**
 * Hosts that always serve the default web URL, even when they do not match
 * `NEXT_PUBLIC_WEB_URL` (preview deployments run on the same origins).
 */
const DEFAULT_HOSTNAMES = ["cap.so", "cap.link", "localhost", "127.0.0.1"];

const normalizeHostname = (value: string | null | undefined) => {
	const first = value?.split(",")[0]?.trim().toLowerCase();
	if (!first) return "";
	// Strip the port so `localhost:3000` still matches `localhost`.
	return first.replace(/:\d+$/, "");
};

/** The hostname the visitor asked for, taken from the incoming request. */
export const requestShareHostname = (headersList: Headers) =>
	normalizeHostname(
		headersList.get("x-forwarded-host") ?? headersList.get("host"),
	);

/**
 * True when the request arrived on the default Cap origin, so share metadata
 * can use `NEXT_PUBLIC_WEB_URL` without a database lookup.
 */
export const isDefaultShareHostname = (
	hostname: string,
	defaultWebUrl: string,
) => {
	if (!hostname) return true;
	if (DEFAULT_HOSTNAMES.includes(hostname)) return true;
	try {
		return new URL(defaultWebUrl).hostname.toLowerCase() === hostname;
	} catch {
		return true;
	}
};

/**
 * The public origin that share metadata must advertise.
 *
 * A share page on a verified custom domain has to emit `og:url`, `og:image`,
 * `og:video` and `canonical` on that same domain. Slack drops the preview
 * image when those values point at another host, so a custom domain link
 * unfurls as a bare title and description.
 *
 * `proxy.ts` already redirects unverified hosts away from `/s/`, so this
 * lookup is a second check rather than the only one. It returns the default
 * web URL whenever the host is unknown, unverified, or the query fails.
 */
export const resolveShareWebUrl = async (
	headersList: Headers,
): Promise<string> => {
	const defaultWebUrl = buildEnv.NEXT_PUBLIC_WEB_URL;
	const hostname = requestShareHostname(headersList);

	if (isDefaultShareHostname(hostname, defaultWebUrl)) return defaultWebUrl;

	try {
		const [organization] = await db()
			.select({ domainVerified: organizations.domainVerified })
			.from(organizations)
			.where(eq(organizations.customDomain, hostname))
			.limit(1);

		if (!organization?.domainVerified) return defaultWebUrl;
		return `https://${hostname}`;
	} catch (error) {
		console.error("Failed to resolve custom domain for share metadata", error);
		return defaultWebUrl;
	}
};
