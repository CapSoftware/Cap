import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SSO_INTENT_MAX_AGE = 10 * 60;

export type SsoLoginIntent = {
	version: 1;
	organizationId: string;
	workosOrganizationId: string;
	connectionId: string;
	actorId: string | null;
	returnTo?: string;
	issuedAt: number;
	nonce: string;
};

function isSafeReturnPath(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		value.length > 1024 ||
		!value.startsWith("/") ||
		value.startsWith("//") ||
		value.includes("\\") ||
		Array.from(value).some((character) => {
			const code = character.charCodeAt(0);
			return code < 32 || code === 127;
		})
	)
		return false;
	try {
		const url = new URL(value, "https://sso.invalid");
		return (
			url.origin === "https://sso.invalid" && !url.pathname.startsWith("//")
		);
	} catch {
		return false;
	}
}

export function ssoLoginErrorPath(
	error: "SsoSessionExpired" | "SsoSignInFailed",
	returnTo?: string,
) {
	const query = new URLSearchParams({ error });
	if (isSafeReturnPath(returnTo) && returnTo !== "/dashboard")
		query.set("next", returnTo);
	return `/login?${query}`;
}

export function ssoIntentCookie(secure: boolean) {
	return {
		name: secure ? "__Host-cap-sso-intent" : "cap-sso-intent",
		options: {
			httpOnly: true,
			secure,
			sameSite: "lax" as const,
			path: "/",
			maxAge: SSO_INTENT_MAX_AGE,
		},
	};
}

export function createSsoLoginIntent(
	input: Pick<
		SsoLoginIntent,
		| "organizationId"
		| "workosOrganizationId"
		| "connectionId"
		| "actorId"
		| "returnTo"
	>,
	secret: string,
	now = Date.now(),
) {
	const payload = Buffer.from(
		JSON.stringify({
			...input,
			returnTo: isSafeReturnPath(input.returnTo)
				? input.returnTo
				: "/dashboard",
			version: 1,
			issuedAt: Math.floor(now / 1000),
			nonce: randomBytes(24).toString("base64url"),
		} satisfies SsoLoginIntent),
	).toString("base64url");
	const signature = createHmac("sha256", secret)
		.update(payload)
		.digest("base64url");
	return `${payload}.${signature}`;
}

export function verifySsoLoginIntent(
	value: string | undefined,
	secret: string,
	now = Date.now(),
): SsoLoginIntent | null {
	if (!value || value.length > 2048) return null;
	const [payload, signature, extra] = value.split(".");
	if (!payload || !signature || extra) return null;
	const expected = createHmac("sha256", secret)
		.update(payload)
		.digest("base64url");
	const actualBuffer = Buffer.from(signature);
	const expectedBuffer = Buffer.from(expected);
	if (
		actualBuffer.length !== expectedBuffer.length ||
		!timingSafeEqual(actualBuffer, expectedBuffer)
	) {
		return null;
	}
	try {
		const data: unknown = JSON.parse(
			Buffer.from(payload, "base64url").toString("utf8"),
		);
		if (!data || typeof data !== "object") return null;
		const intent = data as Partial<SsoLoginIntent>;
		if (
			intent.version !== 1 ||
			typeof intent.organizationId !== "string" ||
			!intent.organizationId ||
			intent.organizationId.length > 64 ||
			typeof intent.workosOrganizationId !== "string" ||
			!/^org_[a-zA-Z0-9]+$/.test(intent.workosOrganizationId) ||
			typeof intent.connectionId !== "string" ||
			!/^conn_[a-zA-Z0-9]+$/.test(intent.connectionId) ||
			(intent.actorId !== null &&
				(typeof intent.actorId !== "string" ||
					!intent.actorId ||
					intent.actorId.length > 64)) ||
			(intent.returnTo !== undefined && !isSafeReturnPath(intent.returnTo)) ||
			typeof intent.issuedAt !== "number" ||
			!Number.isSafeInteger(intent.issuedAt) ||
			typeof intent.nonce !== "string" ||
			!/^[a-zA-Z0-9_-]{32}$/.test(intent.nonce)
		) {
			return null;
		}
		const age = Math.floor(now / 1000) - intent.issuedAt;
		if (age < -30 || age >= SSO_INTENT_MAX_AGE) return null;
		return intent as SsoLoginIntent;
	} catch {
		return null;
	}
}
