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

export const resolveMobileRequestOrigin = (
	configuredWebUrl: string,
	requestUrl: string,
) => {
	const configuredOrigin = (() => {
		try {
			return new URL(configuredWebUrl).origin;
		} catch {
			return configuredWebUrl.replace(/\/+$/, "");
		}
	})();

	try {
		const configured = new URL(configuredOrigin);
		const request = new URL(requestUrl);
		if (
			isLoopbackHostname(configured.hostname) &&
			isPrivateHostname(request.hostname) &&
			(request.protocol === "http:" || request.protocol === "https:")
		) {
			return request.origin;
		}
	} catch {
		return configuredOrigin;
	}

	return configuredOrigin;
};
