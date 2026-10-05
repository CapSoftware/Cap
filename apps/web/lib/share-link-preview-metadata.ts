import { db } from "@cap/database";
import { organizations } from "@cap/database/schema";
import type { Organisation } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { shareLinkUrl } from "./share-link";
import { linkPreviewImagePath, readLinkPreview } from "./share-link-preview";
import type { ShareVideoLinkPreview } from "./share-video-metadata";

/** The verified custom domain of the organization a Cap belongs to. */
export async function organizationShareDomain(
	organizationId: Organisation.OrganisationId,
): Promise<string | null> {
	const [organization] = await db()
		.select({
			customDomain: organizations.customDomain,
			domainVerified: organizations.domainVerified,
		})
		.from(organizations)
		.where(eq(organizations.id, organizationId))
		.limit(1);
	return organization?.customDomain && organization.domainVerified !== null
		? organization.customDomain.toLowerCase()
		: null;
}

/**
 * The parts of a share page's metadata the owner controls. Overrides keep
 * being served after a downgrade (only editing needs Cap Pro), and a failed
 * domain lookup just leaves the canonical URL on the visited host.
 */
export async function getShareLinkPreviewMetadata({
	videoId,
	organizationId,
	metadata,
	webUrl,
}: {
	videoId: string;
	organizationId: Organisation.OrganisationId;
	metadata: unknown;
	webUrl: string;
}): Promise<{
	linkPreview: ShareVideoLinkPreview | null;
	canonicalShareUrl: string | null;
}> {
	const stored = readLinkPreview(metadata, videoId);
	const domain = await organizationShareDomain(organizationId).catch(
		(error) => {
			console.error("Failed to resolve the share link's custom domain", error);
			return null;
		},
	);

	return {
		linkPreview: stored
			? {
					title: stored.title ?? null,
					description: stored.description ?? null,
					image: stored.image
						? {
								url: new URL(
									linkPreviewImagePath(videoId, stored.image),
									webUrl,
								).toString(),
								width: stored.image.width,
								height: stored.image.height,
								type: stored.image.contentType,
							}
						: null,
				}
			: null,
		canonicalShareUrl: domain ? shareLinkUrl(videoId, domain) : null,
	};
}
