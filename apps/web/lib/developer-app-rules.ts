export const DEVELOPER_APP_NAME_MAX_LENGTH = 100;

export const DEVELOPER_APP_NAME_REQUIRED_MESSAGE = "Give the app a name.";
export const DEVELOPER_APP_NAME_LENGTH_MESSAGE = `An app name can be up to ${DEVELOPER_APP_NAME_MAX_LENGTH} characters.`;

export const DEVELOPER_APP_ENVIRONMENTS = [
	"development",
	"production",
] as const;
export type DeveloperAppEnvironment =
	(typeof DEVELOPER_APP_ENVIRONMENTS)[number];
export const DEVELOPER_APP_ENVIRONMENT_MESSAGE =
	"Choose development or production.";

export const DEVELOPER_APP_LOGO_URL_MAX_LENGTH = 1024;
export const DEVELOPER_APP_LOGO_URL_MESSAGE =
	"A logo must be an https URL of up to 1,024 characters.";

export type DeveloperAppName =
	| { ok: true; name: string }
	| { ok: false; message: string };

export function developerAppName(value: unknown): DeveloperAppName {
	const name = typeof value === "string" ? value.trim() : "";
	if (name.length === 0) {
		return { ok: false, message: DEVELOPER_APP_NAME_REQUIRED_MESSAGE };
	}
	if (name.length > DEVELOPER_APP_NAME_MAX_LENGTH) {
		return { ok: false, message: DEVELOPER_APP_NAME_LENGTH_MESSAGE };
	}
	return { ok: true, name };
}

export function developerAppEnvironment(
	value: unknown,
):
	| { ok: true; environment: DeveloperAppEnvironment }
	| { ok: false; message: string } {
	const environment = DEVELOPER_APP_ENVIRONMENTS.find(
		(allowed) => allowed === value,
	);
	return environment
		? { ok: true, environment }
		: { ok: false, message: DEVELOPER_APP_ENVIRONMENT_MESSAGE };
}

export function developerAppLogoUrl(
	value: unknown,
): { ok: true; logoUrl: string | null } | { ok: false; message: string } {
	if (value === null) return { ok: true, logoUrl: null };
	const refused = {
		ok: false as const,
		message: DEVELOPER_APP_LOGO_URL_MESSAGE,
	};
	if (typeof value !== "string") return refused;
	const logoUrl = value.trim();
	if (
		logoUrl.length === 0 ||
		logoUrl.length > DEVELOPER_APP_LOGO_URL_MAX_LENGTH
	) {
		return refused;
	}
	try {
		const url = new URL(logoUrl);
		if (url.protocol !== "https:" || url.hostname.length === 0) return refused;
	} catch {
		return refused;
	}
	return { ok: true, logoUrl };
}
