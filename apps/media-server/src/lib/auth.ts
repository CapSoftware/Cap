import { createHash, timingSafeEqual } from "node:crypto";

// Hashed first so the comparison takes the same time whatever was sent,
// including its length.
function sameSecret(given: string, secret: string): boolean {
	const digest = (value: string) => createHash("sha256").update(value).digest();
	return timingSafeEqual(digest(given), digest(secret));
}

type MediaServerContext = {
	req: { header: (name: string) => string | undefined };
};

export function validateMediaServerSecret(c: MediaServerContext): boolean {
	const secret = process.env.MEDIA_SERVER_WEBHOOK_SECRET;
	if (!secret) {
		console.warn(
			"[media-server] MEDIA_SERVER_WEBHOOK_SECRET is not set — rejecting request. Set this env var to enable authenticated access.",
		);
		return false;
	}
	const given = c.req.header("x-media-server-secret");
	return given !== undefined && sameSecret(given, secret);
}

export function hasMediaServerSecret(c: MediaServerContext): boolean {
	return (
		c.req.header("x-media-server-secret") !== undefined &&
		validateMediaServerSecret(c)
	);
}

export function canReadStatus(c: MediaServerContext): boolean {
	const publicStatus = process.env.MEDIA_SERVER_PUBLIC_STATUS?.toLowerCase();
	return publicStatus === "true" || publicStatus === "1"
		? true
		: validateMediaServerSecret(c);
}
