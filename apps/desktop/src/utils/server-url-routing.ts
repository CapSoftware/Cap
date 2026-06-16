export function hasSameOrigin(left: string, right: string) {
	return new URL(left).origin === new URL(right).origin;
}

export function shouldUseLocalServerSessionForUrl(
	configuredServerUrl: string,
	packagedServerUrl: string,
	isDev: boolean,
) {
	if (isDev) return true;

	return !hasSameOrigin(configuredServerUrl, packagedServerUrl);
}

export function resolveServerRequestPath(
	path: string,
	configuredServerUrl: string,
	packagedServerUrl: string,
) {
	if (hasSameOrigin(configuredServerUrl, packagedServerUrl)) return path;

	const packagedOrigin = new URL(packagedServerUrl).origin;
	const url = new URL(path, packagedServerUrl);
	if (url.origin !== packagedOrigin) return path;

	return new URL(
		`${url.pathname}${url.search}${url.hash}`,
		configuredServerUrl,
	).toString();
}
