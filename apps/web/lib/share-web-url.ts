import { db } from "@cap/database";
import { organizations } from "@cap/database/schema";
import { buildEnv, serverEnv } from "@cap/env";
import { eq } from "drizzle-orm";

const DEFAULT_HOSTNAMES = ["cap.so", "cap.link", "localhost", "127.0.0.1"];

const normalizeHostname = (value: string | null | undefined) => {
	const first = value?.split(",")[0]?.trim().toLowerCase();
	if (!first) return "";
	return first.replace(/:\d+$/, "");
};

// `WEB_URL` is a full URL while the `VERCEL_*_HOST` values are bare hosts.
const toHostname = (value: string) => {
	try {
		return new URL(value).hostname.toLowerCase();
	} catch {
		return normalizeHostname(value);
	}
};

export const requestShareHostname = (headersList: Headers) =>
	normalizeHostname(
		headersList.get("x-forwarded-host") ?? headersList.get("host"),
	);

export const isDefaultShareHostname = (
	hostname: string,
	defaultWebUrl: string,
	deploymentHostnames: readonly string[] = [],
) => {
	if (!hostname) return true;
	if (DEFAULT_HOSTNAMES.includes(hostname)) return true;
	if (deploymentHostnames.some((value) => toHostname(value) === hostname))
		return true;
	try {
		return new URL(defaultWebUrl).hostname.toLowerCase() === hostname;
	} catch {
		// A misconfigured origin must not promote the request host.
		return true;
	}
};

// Mirrors the `mainOrigins` list in `proxy.ts`, so a preview deployment does
// not pay for the organization lookup below.
const deploymentHostnames = (): string[] => {
	try {
		const env = serverEnv();
		return [
			env.WEB_URL,
			env.VERCEL_URL_HOST,
			env.VERCEL_BRANCH_URL_HOST,
			env.VERCEL_PROJECT_PRODUCTION_URL_HOST,
		].filter((value): value is string => Boolean(value));
	} catch {
		return [];
	}
};

/**
 * Slack drops the preview image when `og:url` names a different host than the
 * link it unfurls, so a share page on a verified custom domain has to advertise
 * that domain rather than `NEXT_PUBLIC_WEB_URL`. See #2122.
 *
 * `proxy.ts` already redirects unverified hosts away from `/s/`. This lookup is
 * a second check, and it falls back whenever the host is unknown, unverified,
 * or the query throws.
 */
export const resolveShareWebUrl = async (
	headersList: Headers,
): Promise<string> => {
	const defaultWebUrl = buildEnv.NEXT_PUBLIC_WEB_URL;
	const hostname = requestShareHostname(headersList);

	if (isDefaultShareHostname(hostname, defaultWebUrl, deploymentHostnames()))
		return defaultWebUrl;

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
