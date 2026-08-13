const LOOM_HOSTNAME = "loom.com";
const LOOM_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{10,128}$/;

export const LOOM_ORIGIN = "https://www.loom.com";

export function isValidLoomVideoId(value: string): boolean {
	return LOOM_VIDEO_ID_PATTERN.test(value);
}

function isLoomHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/\.$/, "");
	return (
		normalized === LOOM_HOSTNAME || normalized.endsWith(`.${LOOM_HOSTNAME}`)
	);
}

function isTrustedLoomUrl(url: URL): boolean {
	return (
		url.protocol === "https:" &&
		(url.port === "" || url.port === "443") &&
		url.username === "" &&
		url.password === "" &&
		isLoomHostname(url.hostname)
	);
}

export function extractLoomVideoId(value: string): string | null {
	try {
		const url = new URL(value);
		if (!isTrustedLoomUrl(url)) return null;

		const id = url.pathname.split("/").filter(Boolean).at(-1);
		return id && isValidLoomVideoId(id) ? id : null;
	} catch {
		return null;
	}
}

export function normalizeLoomMediaUrl(value: string): string | null {
	try {
		const url = new URL(value);
		return isTrustedLoomUrl(url) ? url.toString() : null;
	} catch {
		return null;
	}
}
