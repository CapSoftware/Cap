import { db } from "@cap/database";
import { organizations, videos } from "@cap/database/schema";
import { buildEnv, serverEnv } from "@cap/env";
import type { Video } from "@cap/web-domain";
import { eq, sql } from "drizzle-orm";
import { videoBelongsToOrganization } from "@/lib/cap-analytics-access";

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
		const organization = await findVerifiedDomainOrganization(hostname);
		if (!organization) return defaultWebUrl;
		return `https://${hostname}`;
	} catch (error) {
		console.error("Failed to resolve custom domain for share metadata", error);
		return defaultWebUrl;
	}
};

const findVerifiedDomainOrganization = async (hostname: string) => {
	const [organization] = await db()
		.select({
			id: organizations.id,
			domainVerified: organizations.domainVerified,
		})
		.from(organizations)
		.where(eq(organizations.customDomain, hostname))
		.limit(1);

	return organization?.domainVerified ? organization : null;
};

const mainOriginShareUrl = (
	videoId: string,
	searchParams: Record<string, string | string[] | undefined>,
) => {
	const url = new URL(
		`/s/${encodeURIComponent(videoId)}`,
		buildEnv.NEXT_PUBLIC_WEB_URL,
	);
	for (const [key, value] of Object.entries(searchParams)) {
		for (const entry of Array.isArray(value) ? value : [value]) {
			if (entry !== undefined) url.searchParams.append(key, entry);
		}
	}
	return url.toString();
};

/**
 * The session cookie belongs to the main web origin, so a share page served on
 * a custom domain never knows who is watching. A restricted video sends the
 * viewer to the same share page on the main origin, where their session
 * decides access. Returns null on the main origin.
 */
export const resolveRestrictedShareRedirect = async (
	headersList: Headers,
	videoId: string,
	searchParams: Record<string, string | string[] | undefined>,
): Promise<string | null> => {
	const defaultWebUrl = buildEnv.NEXT_PUBLIC_WEB_URL;
	if ((await resolveShareWebUrl(headersList)) === defaultWebUrl) return null;

	return mainOriginShareUrl(videoId, searchParams);
};

/**
 * A verified custom domain belongs to one organization, but `proxy.ts` lets it
 * serve any `/s/` path. A video that is not in that organization, not shared
 * with it and not in one of its spaces is sent to the main origin, so nobody
 * can publish their own video under another organization's domain. Returns
 * null on the main origin and while the video row does not exist yet.
 */
export const resolveForeignShareRedirect = async (
	headersList: Headers,
	videoId: Video.VideoId,
	searchParams: Record<string, string | string[] | undefined>,
): Promise<string | null> => {
	const hostname = requestShareHostname(headersList);
	if (
		isDefaultShareHostname(
			hostname,
			buildEnv.NEXT_PUBLIC_WEB_URL,
			deploymentHostnames(),
		)
	)
		return null;

	const organization = await findVerifiedDomainOrganization(hostname);
	if (!organization) return null;

	const [video] = await db()
		.select({
			belongsToDomain:
				sql<boolean>`${videoBelongsToOrganization(organization.id)}`.mapWith(
					Boolean,
				),
		})
		.from(videos)
		.where(eq(videos.id, videoId))
		.limit(1);

	if (!video || video.belongsToDomain) return null;
	return mainOriginShareUrl(videoId, searchParams);
};
