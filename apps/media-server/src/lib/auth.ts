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
	return c.req.header("x-media-server-secret") === secret;
}

export function hasMediaServerSecret(c: MediaServerContext): boolean {
	return (
		c.req.header("x-media-server-secret") !== undefined &&
		validateMediaServerSecret(c)
	);
}

export function canReadStatus(c: MediaServerContext): boolean {
	const publicStatus = process.env.MEDIA_SERVER_PUBLIC_STATUS?.toLowerCase();
	return publicStatus === "false" || publicStatus === "0"
		? validateMediaServerSecret(c)
		: true;
}
