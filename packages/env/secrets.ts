export const REQUIRED_SELF_HOST_SECRETS = [
	"NEXTAUTH_SECRET",
	"DATABASE_ENCRYPTION_KEY",
	"MEDIA_SERVER_WEBHOOK_SECRET",
] as const;

export type RequiredSelfHostSecret =
	(typeof REQUIRED_SELF_HOST_SECRETS)[number];

export const KNOWN_PLACEHOLDER_SECRETS: ReadonlySet<string> = new Set([
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

export type InsecureSecret = {
	name: RequiredSelfHostSecret;
	problem: "missing" | "placeholder";
};

export function findInsecureSecrets(
	env: Record<string, string | undefined>,
	names: readonly RequiredSelfHostSecret[] = REQUIRED_SELF_HOST_SECRETS,
): InsecureSecret[] {
	const problems: InsecureSecret[] = [];
	for (const name of names) {
		const value = env[name]?.trim();
		if (!value) problems.push({ name, problem: "missing" });
		else if (KNOWN_PLACEHOLDER_SECRETS.has(value.toLowerCase()))
			problems.push({ name, problem: "placeholder" });
	}
	return problems;
}

export function formatInsecureSecrets(problems: InsecureSecret[]): string {
	const lines = problems.map(
		({ name, problem }) =>
			`  - ${name} is ${problem === "missing" ? "not set" : "set to a publicly known placeholder value"}`,
	);
	return [
		"Refusing to start: insecure secrets.",
		...lines,
		"Generate a unique value for each with `openssl rand -hex 32` and set it in your environment (.env / platform variables).",
		"MEDIA_SERVER_WEBHOOK_SECRET must be identical on cap-web and the media server.",
	].join("\n");
}
