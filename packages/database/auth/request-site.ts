import { serverEnv } from "@cap/env";

const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type SiteCheckedRequest = {
	method: string;
	url: string;
	headers: Pick<Headers, "get" | "has">;
};

const parseUrl = (value: string | null | undefined) => {
	if (!value) return null;
	try {
		return new URL(value);
	} catch {
		return null;
	}
};

const isOwnOrigin = (origin: URL, request: SiteCheckedRequest) => {
	const ownHosts = [
		request.headers.get("x-forwarded-host")?.split(",")[0]?.trim(),
		request.headers.get("host"),
		parseUrl(request.url)?.host,
	];
	if (ownHosts.includes(origin.host)) return true;

	let webUrl: string | undefined;
	try {
		webUrl = serverEnv().WEB_URL;
	} catch {
		return false;
	}
	return parseUrl(webUrl)?.origin === origin.origin;
};

export const isCrossSiteCookieWrite = (request: SiteCheckedRequest) => {
	if (READ_ONLY_METHODS.has(request.method.toUpperCase())) return false;
	if (request.headers.has("authorization")) return false;

	// Sec-Fetch-Site is set by the browser and cannot be forged by page script,
	// so it decides when present. Origin is the fallback for clients that
	// predate fetch metadata and for plain-http self-hosted installs, where
	// browsers do not send Sec-Fetch-* headers.
	const fetchSite = request.headers.get("sec-fetch-site");
	if (fetchSite) return fetchSite === "cross-site";

	const origin = request.headers.get("origin");
	if (!origin) return false;

	const originUrl = parseUrl(origin);
	return !originUrl || !isOwnOrigin(originUrl, request);
};
