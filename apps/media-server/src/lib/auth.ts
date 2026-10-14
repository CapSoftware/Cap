import { createHash, timingSafeEqual } from "node:crypto";

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
	const provided = c.req.header("x-media-server-secret");
	if (!provided) return false;
	const expectedDigest = createHash("sha256").update(secret).digest();
	const providedDigest = createHash("sha256").update(provided).digest();
	return timingSafeEqual(expectedDigest, providedDigest);
}
