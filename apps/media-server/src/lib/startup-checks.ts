const KNOWN_PLACEHOLDER_SECRETS = new Set([
	"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
	"abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
	"fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
	"c7a1e98e1e5e4cec5a3fbf5eaf502d262fb99807ae2be8ee70537409e29cb6f9",
	"fe337b52749070bb7b5d2c78cff9948439ea73cbc1869ba39d350e6c24db53b1",
	"local-media-server-secret",
	"changeme",
	"change-me",
	"secret",
]);

export function getWebhookSecretProblem(
	env: Record<string, string | undefined> = process.env,
): string | null {
	const value = env.MEDIA_SERVER_WEBHOOK_SECRET?.trim();
	if (!value) return "MEDIA_SERVER_WEBHOOK_SECRET is not set";
	if (
		KNOWN_PLACEHOLDER_SECRETS.has(value.toLowerCase()) &&
		env.MEDIA_SERVER_ALLOW_INSECURE_SECRET !== "true"
	) {
		return "MEDIA_SERVER_WEBHOOK_SECRET is set to a publicly known placeholder value";
	}
	return null;
}

export function assertSecureStartup(
	env: Record<string, string | undefined> = process.env,
) {
	const problem = getWebhookSecretProblem(env);
	if (!problem) return;
	console.error(
		[
			`[media-server] Refusing to start: ${problem}.`,
			"Generate one with `openssl rand -hex 32` and set the same value on cap-web and the media server.",
		].join("\n"),
	);
	process.exit(1);
}
