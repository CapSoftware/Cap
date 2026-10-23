const isLoopbackHostname = (hostname: string) => {
	const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (
		normalized === "localhost" ||
		normalized === "0.0.0.0" ||
		normalized === "::1"
	) {
		return true;
	}

	const octets = normalized.split(".").map(Number);
	return (
		octets.length === 4 &&
		octets.every(
			(octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255,
		) &&
		octets[0] === 127
	);
};

const isPrivateHostname = (hostname: string) => {
	const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (isLoopbackHostname(normalized) || normalized.endsWith(".local")) {
		return true;
	}

	if (/^(?:fc|fd|fe8|fe9|fea|feb)[0-9a-f]*:/i.test(normalized)) {
		return true;
	}

	const octets = normalized.split(".").map(Number);
	if (
		octets.length !== 4 ||
		!octets.every(
			(octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255,
		)
	) {
		return false;
	}

	return (
		octets[0] === 10 ||
		(octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31) ||
		(octets[0] === 192 && octets[1] === 168)
	);
};

const getOrigin = (url: string) => {
	try {
		return new URL(url).origin;
	} catch {
		return url.replace(/\/+$/, "");
	}
};

export const resolveMobileRequestOrigin = (
	configuredWebUrl: string,
	requestUrl: string,
	requestHost?: string,
) => {
	const configuredOrigin = getOrigin(configuredWebUrl);

	try {
		const configured = new URL(configuredOrigin);
		const request = new URL(requestUrl);
		if (!isLoopbackHostname(configured.hostname)) return configuredOrigin;
		const isHttpRequest =
			request.protocol === "http:" || request.protocol === "https:";

		if (
			!isLoopbackHostname(request.hostname) &&
			isPrivateHostname(request.hostname) &&
			isHttpRequest
		)
			return request.origin;

		if (requestHost && isHttpRequest) {
			const host = requestHost.split(",")[0]?.trim();
			if (host) {
				const hostUrl = new URL(`${request.protocol}//${host}`);
				if (isPrivateHostname(hostUrl.hostname)) return hostUrl.origin;
			}
		}

		if (isPrivateHostname(request.hostname) && isHttpRequest)
			return request.origin;
	} catch {
		return configuredOrigin;
	}

	return configuredOrigin;
};

export const resolveMobileWebResourceUrl = (
	resourceUrl: string,
	configuredWebUrl: string,
	publicOrigin: string,
) => {
	try {
		const resource = new URL(resourceUrl);
		if (resource.origin !== getOrigin(configuredWebUrl)) return resourceUrl;

		const destination = new URL(publicOrigin);
		resource.protocol = destination.protocol;
		resource.host = destination.host;
		return resource.toString();
	} catch {
		return resourceUrl;
	}
};
