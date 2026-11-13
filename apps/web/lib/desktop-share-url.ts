import { db } from "@cap/database";
import { organizations } from "@cap/database/schema";
import { buildEnv, NODE_ENV } from "@cap/env";
import type { Organisation } from "@cap/web-domain";
import { eq } from "drizzle-orm";

/**
 * The desktop apps build share links from their server URL, so a team with a
 * verified custom domain would otherwise copy a default-domain link after an
 * Instant recording or upload. Returns the custom domain link for the video's
 * organization, or undefined so the desktop keeps its own link.
 */
export async function getDesktopShareUrl(
	organizationId: Organisation.OrganisationId,
	videoId: string,
): Promise<string | undefined> {
	if (buildEnv.NEXT_PUBLIC_IS_CAP !== "true" || NODE_ENV !== "production")
		return undefined;

	try {
		const [organization] = await db()
			.select({
				customDomain: organizations.customDomain,
				domainVerified: organizations.domainVerified,
			})
			.from(organizations)
			.where(eq(organizations.id, organizationId))
			.limit(1);

		const customDomain = organization?.customDomain?.trim();
		if (!customDomain || !organization?.domainVerified) return undefined;
		return `https://${customDomain}/s/${videoId}`;
	} catch (error) {
		console.error("Failed to resolve custom domain for desktop link", error);
		return undefined;
	}
}
