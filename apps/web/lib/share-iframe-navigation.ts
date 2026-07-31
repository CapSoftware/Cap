const SHARE_VIDEO_PATH_PATTERN = /^\/s\/([^/]+)\/?$/;

export function getShareIframeRedirectUrl({
	method,
	requestUrl,
	fetchDestination,
}: {
	method: string;
	requestUrl: string;
	fetchDestination: string | null;
}) {
	if (method !== "GET" || fetchDestination?.toLowerCase() !== "iframe") {
		return null;
	}

	const url = new URL(requestUrl);
	const videoId = url.pathname.match(SHARE_VIDEO_PATH_PATTERN)?.[1];
	if (!videoId) return null;

	url.pathname = `/embed/${videoId}`;
	return url;
}
