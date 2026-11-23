import { serverEnv } from "@cap/env";

const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type SiteCheckedRequest = {
	method: string;
	url: string;
	headers: Pick<Headers, "get">;
};

const parseUrl = (value: string | null | undefined) => {
	if (!value) return null;
	try {
		return new URL(value);
	} catch {
		return null;
	}
};

const getWebUrl = () => {
	try {
		return parseUrl(serverEnv().WEB_URL);
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
	return getWebUrl()?.origin === origin.origin;
};

const isOwnSiteOrigin = (origin: URL, request: SiteCheckedRequest) => {
	if (isOwnOrigin(origin, request)) return true;
	const webUrl = getWebUrl();
	if (!webUrl || webUrl.protocol !== origin.protocol) return false;
	const counterpart = webUrl.host.startsWith("www.")
		? webUrl.host.slice(4)
		: `www.${webUrl.host}`;
	return origin.host === counterpart;
};

// Callers must only consult this on the cookie-auth path: a successfully
// authenticated bearer token returns before the check is reached. The presence
// of an Authorization header is not proof of bearer auth, so it is ignored
// here — an invalid bearer that falls back to the cookie still gets checked.
export const isCrossSiteCookieWrite = (request: SiteCheckedRequest) => {
	if (READ_ONLY_METHODS.has(request.method.toUpperCase())) return false;

	// Sec-Fetch-Site is set by the browser and cannot be forged by page script,
	// so it decides when present. Origin is the fallback for clients that
	// predate fetch metadata and for plain-http self-hosted installs, where
	// browsers do not send Sec-Fetch-* headers.
	const fetchSite = request.headers.get("sec-fetch-site");
	if (fetchSite === "cross-site") return true;
	// same-site also covers every sibling subdomain, so a same-site write must
	// come from the app itself or its www counterpart.
	if (fetchSite === "same-site") {
		const sameSiteOrigin = parseUrl(request.headers.get("origin"));
		return !sameSiteOrigin || !isOwnSiteOrigin(sameSiteOrigin, request);
	}
	if (fetchSite) return false;

	const origin = request.headers.get("origin");
	if (!origin) return false;

	const originUrl = parseUrl(origin);
	return !originUrl || !isOwnOrigin(originUrl, request);
};
