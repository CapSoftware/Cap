import { db } from "@cap/database";
import { organizations } from "@cap/database/schema";
import { buildEnv, serverEnv } from "@cap/env";
import { eq } from "drizzle-orm";

/**
 * Hosts that never belong to a customer, so they skip the lookup below.
 * `proxy.ts` treats the same set as a main origin.
 */
const DEFAULT_HOSTNAMES = ["cap.so", "cap.link", "localhost", "127.0.0.1"];

const normalizeHostname = (value: string | null | undefined) => {
	const first = value?.split(",")[0]?.trim().toLowerCase();
	if (!first) return "";
	// Strip the port so `localhost:3000` still matches `localhost`.
	return first.replace(/:\d+$/, "");
};

/** Accepts a bare host (`cap-git-x.vercel.app`) or a full URL. */
const toHostname = (value: string) => {
	try {
		return new URL(value).hostname.toLowerCase();
	} catch {
		return normalizeHostname(value);
	}
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

/**
 * The deployment origins that `proxy.ts` treats as main origins. They never
 * belong to a customer, so recognizing them skips a pointless query on every
 * preview deployment.
 */
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
