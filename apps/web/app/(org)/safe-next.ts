const DEFAULT_AUTH_REDIRECT = "/dashboard";

export const getSafeNextPath = (
	next: string | string[] | null | undefined,
	origin: string,
) => {
	const value = Array.isArray(next) ? next[0] : next;
	if (!value) return DEFAULT_AUTH_REDIRECT;

	try {
		const base = new URL(origin);
		const url = new URL(value, base);
		if (url.origin !== base.origin) return DEFAULT_AUTH_REDIRECT;
		const path = `${url.pathname}${url.search}${url.hash}`;
		// Path normalization can turn inputs like /.//evil.com or
		// https://<origin>//evil.com into //evil.com, which browsers treat as a
		// protocol-relative URL when emitted in a Location header.
		if (!path.startsWith("/") || path.startsWith("//") || path[1] === "\\") {
			return DEFAULT_AUTH_REDIRECT;
		}
		return path;
	} catch {
		return DEFAULT_AUTH_REDIRECT;
	}
};
