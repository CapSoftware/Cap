import { buildEnv, NODE_ENV } from "@cap/env";

export { formatTimestamp } from "./format-timestamp";

export function shareLinkUrl(videoId: string, customDomain: string | null) {
	return customDomain &&
		(NODE_ENV === "development" || buildEnv.NEXT_PUBLIC_IS_CAP)
		? `https://${customDomain}/s/${videoId}`
		: `${buildEnv.NEXT_PUBLIC_WEB_URL}/s/${videoId}`;
}
