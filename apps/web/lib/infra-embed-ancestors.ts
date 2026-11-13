export const DEVELOPER_EMBED_PATH = /^\/dev\/([A-Za-z0-9_-]{16,64})\/embed\/?$/;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

export const isLocalOrigin = (url: URL) =>
	url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);

export function embedFrameSource(stored: string): string | null {
	let url: URL;
	try {
		url = new URL(stored);
	} catch {
		return null;
	}
	if (url.origin !== stored || url.hostname.includes("*")) return null;
	if (url.protocol === "https:" || isLocalOrigin(url)) return url.origin;
	return null;
}

// A list that is set but holds no usable entry still restricts framing to the
// hosted origin: a bad stored row must never widen who can embed the player.
export function embedFrameAncestors(stored: readonly string[]): string | null {
	if (stored.length === 0) return null;
	const sources = new Set<string>();
	for (const entry of stored) {
		const source = embedFrameSource(entry);
		if (source) sources.add(source);
	}
	return ["frame-ancestors", "'self'", ...sources].join(" ");
}

export function withFrameAncestors(
	existing: string | null,
	frameAncestors: string,
): string {
	const directives = (existing ?? "")
		.split(";")
		.map((directive) => directive.trim())
		.filter(
			(directive) =>
				directive.length > 0 &&
				directive.split(/\s+/)[0]?.toLowerCase() !== "frame-ancestors",
		);
	return [...directives, frameAncestors].join("; ");
}
