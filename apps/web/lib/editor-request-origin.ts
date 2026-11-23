import { serverEnv } from "@cap/env";

export function editorRequestOrigin(
	originalUrl: string,
	originHeader: string | undefined,
	webUrl: string | undefined = serverEnv().WEB_URL,
) {
	const requestOrigin = new URL(originalUrl).origin;
	if (!originHeader) return requestOrigin;
	if (originHeader === requestOrigin) return originHeader;
	if (webUrl && URL.canParse(webUrl) && new URL(webUrl).origin === originHeader)
		return originHeader;
	return null;
}
