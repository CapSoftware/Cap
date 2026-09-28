import { buildEnv, NODE_ENV } from "@cap/env";

export function formatTimestamp(seconds: number) {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	if (h > 0)
		return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
	return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Where a recording is shared: its owner's verified custom domain where Cap
 * serves one, otherwise Cap itself.
 */
export function shareLinkUrl(videoId: string, customDomain: string | null) {
	return customDomain &&
		(NODE_ENV === "development" || buildEnv.NEXT_PUBLIC_IS_CAP)
		? `https://${customDomain}/s/${videoId}`
		: `${buildEnv.NEXT_PUBLIC_WEB_URL}/s/${videoId}`;
}
