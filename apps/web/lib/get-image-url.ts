/**
 * Helper to check if an imageKey is an S3 key that needs RPC resolution
 * @param imageKeyOrUrl - Can be an S3 key or a legacy URL
 * @returns true if it's an S3 key that needs RPC resolution
 */
export function isS3Key(imageKeyOrUrl: string | null | undefined): boolean {
	if (!imageKeyOrUrl) return false;
	return (
		imageKeyOrUrl.startsWith("users/") ||
		imageKeyOrUrl.startsWith("organizations/")
	);
}

/**
 * Helper to convert an imageKey (S3 key) or legacy URL to a usable URL
 * @param imageKeyOrUrl - Can be an S3 key (starts with "users/" or "organizations/") or a legacy URL
 * @returns A URL that can be used in img tags or Next.js Image components
 */
export function getImageUrl(
	imageKeyOrUrl: string | null | undefined,
): string | null {
	if (!imageKeyOrUrl) return null;

	// If it's an S3 key, return as-is (will be handled by RPC hook)
	if (isS3Key(imageKeyOrUrl)) {
		return imageKeyOrUrl;
	}

	// Otherwise, return as-is (legacy URL or external URL)
	return imageKeyOrUrl;
}
