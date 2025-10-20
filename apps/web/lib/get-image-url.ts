/**
 * Helper to convert an imageKey (S3 key) or legacy URL to a usable URL
 * @param imageKeyOrUrl - Can be an S3 key (starts with "users/" or "organizations/") or a legacy URL
 * @returns A URL that can be used in img tags or Next.js Image components
 */
export function getImageUrl(
	imageKeyOrUrl: string | null | undefined,
): string | null {
	if (!imageKeyOrUrl) return null;
	//
	// If it's an S3 key (starts with users/ or organizations/), convert to API route
	if (
		imageKeyOrUrl.startsWith("users/") ||
		imageKeyOrUrl.startsWith("organizations/")
	) {
		return `/api/icon?key=${encodeURIComponent(imageKeyOrUrl)}`;
	}

	// Otherwise, return as-is (legacy URL or external URL)
	return imageKeyOrUrl;
}
