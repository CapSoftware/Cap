import crypto from "node:crypto";
import { serverEnv } from "@cap/env";
import { and, eq } from "drizzle-orm";
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";
import CredentialsProvider from "next-auth/providers/credentials";
import { db } from "../index.ts";
import { accounts, users } from "../schema.ts";
import { isBlockedAccountEmail } from "./domain-utils.ts";

export const GOOGLE_ONE_TAP_PROVIDER_ID = "google-one-tap";
export const GOOGLE_ONE_TAP_NONCE_MAX_AGE_SECONDS = 5 * 60;
export const GOOGLE_ONE_TAP_MAX_CREDENTIAL_LENGTH = 4096;

const GOOGLE_JWKS_URL = new URL("https://www.googleapis.com/oauth2/v3/certs");
const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];
const CLOCK_TOLERANCE_SECONDS = 30;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;

let googleJwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function getGoogleJwks() {
	googleJwks ??= createRemoteJWKSet(GOOGLE_JWKS_URL);
	return googleJwks;
}

export function googleOneTapNonceCookie(secure: boolean) {
	return {
		name: secure
			? "__Secure-cap-google-one-tap-nonce"
			: "cap-google-one-tap-nonce",
		options: {
			httpOnly: true,
			secure,
			sameSite: "lax" as const,
			path: "/api/auth",
			maxAge: GOOGLE_ONE_TAP_NONCE_MAX_AGE_SECONDS,
		},
	};
}

export function googleOneTapNonceCookieForWebUrl(webUrl: string) {
	return googleOneTapNonceCookie(new URL(webUrl).protocol === "https:");
}

export function createGoogleOneTapNonce() {
	return crypto.randomBytes(32).toString("base64url");
}

export function readCookie(
	header: string | null | undefined,
	name: string,
): string | null {
	if (!header) return null;
	for (const part of header.split(";")) {
		const separator = part.indexOf("=");
		if (separator === -1) continue;
		if (part.slice(0, separator).trim() !== name) continue;
		const value = part.slice(separator + 1).trim();
		try {
			return decodeURIComponent(value);
		} catch {
			return null;
		}
	}
	return null;
}

function noncesMatch(provided: string, expected: string) {
	const digest = (value: string) =>
		crypto.createHash("sha256").update(value).digest();
	return crypto.timingSafeEqual(digest(provided), digest(expected));
}

export type GoogleOneTapClaims = {
	sub: string;
	email: string;
};

export async function verifyGoogleOneTapCredential(input: {
	credential: unknown;
	expectedNonce: string | null;
	clientId: string | undefined;
}): Promise<GoogleOneTapClaims | null> {
	const { credential, expectedNonce, clientId } = input;
	if (!clientId) return null;
	if (typeof credential !== "string" || !credential) return null;
	if (credential.length > GOOGLE_ONE_TAP_MAX_CREDENTIAL_LENGTH) return null;
	if (!expectedNonce || !NONCE_PATTERN.test(expectedNonce)) return null;

	let payload: JWTPayload;
	try {
		({ payload } = await jwtVerify(credential, getGoogleJwks(), {
			issuer: GOOGLE_ISSUERS,
			audience: clientId,
			algorithms: ["RS256"],
			clockTolerance: CLOCK_TOLERANCE_SECONDS,
			maxTokenAge: "1h",
			requiredClaims: ["iss", "aud", "sub", "exp", "iat"],
		}));
	} catch {
		return null;
	}

	if (payload.aud !== clientId) return null;
	if (payload.azp !== undefined && payload.azp !== clientId) return null;
	if (payload.email_verified !== true) return null;
	if (typeof payload.nonce !== "string") return null;
	if (!noncesMatch(payload.nonce, expectedNonce)) return null;
	if (typeof payload.sub !== "string" || !payload.sub) return null;
	if (typeof payload.email !== "string" || !payload.email) return null;

	return { sub: payload.sub, email: payload.email };
}

export async function authorizeGoogleOneTap(
	credential: unknown,
	cookieHeader: string | null | undefined,
) {
	const env = serverEnv();
	if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
	const cookie = googleOneTapNonceCookieForWebUrl(env.WEB_URL);
	const claims = await verifyGoogleOneTapCredential({
		credential,
		expectedNonce: readCookie(cookieHeader, cookie.name),
		clientId: env.GOOGLE_CLIENT_ID,
	});
	if (!claims) return null;

	// SECURITY: One Tap only signs in a Google identity that the redirect flow
	// already linked. Creating users or linking by email here would bypass
	// next-auth's OAuthAccountNotLinked protection for existing accounts.
	const [user] = await db()
		.select({
			id: users.id,
			email: users.email,
			name: users.name,
			image: users.image,
		})
		.from(accounts)
		.innerJoin(users, eq(users.id, accounts.userId))
		.where(
			and(
				eq(accounts.provider, "google"),
				eq(accounts.providerAccountId, claims.sub),
			),
		)
		.limit(1);
	if (!user) return null;
	if (isBlockedAccountEmail(user.email)) return null;

	return {
		id: user.id,
		email: user.email,
		name: user.name,
		image: user.image,
	};
}

export function GoogleOneTapProvider() {
	return CredentialsProvider({
		id: GOOGLE_ONE_TAP_PROVIDER_ID,
		name: "Google One Tap",
		credentials: {
			credential: { type: "text" },
		},
		async authorize(credentials, req) {
			const cookieHeader = req?.headers?.cookie;
			return authorizeGoogleOneTap(
				credentials?.credential,
				typeof cookieHeader === "string" ? cookieHeader : null,
			);
		},
	});
}
