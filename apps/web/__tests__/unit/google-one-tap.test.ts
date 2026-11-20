import { authOptions } from "@cap/database/auth/auth-options";
import {
	authorizeGoogleOneTap,
	GOOGLE_ONE_TAP_MAX_CREDENTIAL_LENGTH,
	GOOGLE_ONE_TAP_PROVIDER_ID,
	GoogleOneTapProvider,
	readCookie,
	verifyGoogleOneTapCredential,
} from "@cap/database/auth/google-one-tap";
import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import {
	createLocalJWKSet,
	exportJWK,
	generateKeyPair,
	type JWTPayload,
	SignJWT,
} from "jose";
import type { NextAuthOptions } from "next-auth";
import type { CredentialsConfig } from "next-auth/providers/credentials";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type LinkedUser = {
	provider: string;
	providerAccountId: string;
	id: string;
	email: string;
	name: string | null;
	image: string | null;
};

const mocks = vi.hoisted(() => ({
	jwks: null as null | ((...args: unknown[]) => Promise<unknown>),
	linked: [] as LinkedUser[],
	queries: [] as { sql: string; params: unknown[] }[],
}));

const env = vi.hoisted(() => ({
	GOOGLE_CLIENT_ID: "cap-web.apps.googleusercontent.com" as string | undefined,
	GOOGLE_CLIENT_SECRET: "google-secret" as string | undefined,
	WEB_URL: "https://cap.so",
	NEXTAUTH_SECRET: "next-auth-secret",
	CAP_BLOCKED_SIGNUP_DOMAINS: undefined as string | undefined,
	CAP_ALLOWED_SIGNUP_DOMAINS: undefined as string | undefined,
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => env,
	buildEnv: { NEXT_PUBLIC_IS_CAP: undefined },
}));

vi.mock("jose", async (importOriginal) => {
	const actual = await importOriginal<typeof import("jose")>();
	return {
		...actual,
		createRemoteJWKSet: (url: URL) => {
			if (url.href !== "https://www.googleapis.com/oauth2/v3/certs") {
				throw new Error(`Unexpected JWKS URL ${url.href}`);
			}
			return (...args: unknown[]) => {
				if (!mocks.jwks) throw new Error("JWKS not configured");
				return mocks.jwks(...args);
			};
		},
	};
});

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				innerJoin: () => ({
					where: (condition: SQL) => ({
						limit: async () => {
							const query = new MySqlDialect().sqlToQuery(condition);
							mocks.queries.push({ sql: query.sql, params: query.params });
							if (
								query.sql !==
								"(`accounts`.`provider` = ? and `accounts`.`providerAccountId` = ?)"
							) {
								throw new Error(`Unexpected One Tap predicate ${query.sql}`);
							}
							const [provider, providerAccountId] = query.params;
							return mocks.linked
								.filter(
									(row) =>
										row.provider === provider &&
										row.providerAccountId === providerAccountId,
								)
								.map(({ id, email, name, image }) => ({
									id,
									email,
									name,
									image,
								}));
						},
					}),
				}),
				where: () => ({ limit: async () => [] }),
			}),
		}),
	}),
}));

vi.mock("../../../../packages/database/auth/drizzle-adapter", () => ({
	DrizzleAdapter: () => ({}),
}));

vi.mock("../../../../packages/database/auth/disposable-signup", () => ({
	isDisposableEmailSignup: async () => false,
}));

const CLIENT_ID = "cap-web.apps.googleusercontent.com";
const NONCE = "n0nce_value-0123456789abcdefABCDEF0123456";
const COOKIE_NAME = "__Secure-cap-google-one-tap-nonce";
const SUB = "109876543210987654321";
const USER: LinkedUser = {
	provider: "google",
	providerAccountId: SUB,
	id: "user_linked",
	email: "alex@example.com",
	name: "Alex",
	image: null,
};

let signingKey: CryptoKey;
let otherKey: CryptoKey;

beforeAll(async () => {
	const pair = await generateKeyPair("RS256");
	const other = await generateKeyPair("RS256");
	signingKey = pair.privateKey;
	otherKey = other.privateKey;
	const jwk = { ...(await exportJWK(pair.publicKey)), kid: "google-key" };
	const localJwks = createLocalJWKSet({ keys: [{ ...jwk, alg: "RS256" }] });
	mocks.jwks = (...args: unknown[]) =>
		(localJwks as (...a: unknown[]) => Promise<unknown>)(...args);
});

async function token(
	claims: JWTPayload = {},
	options: {
		key?: CryptoKey;
		issuedAt?: number;
		expiresAt?: number;
	} = {},
) {
	const now = Math.floor(Date.now() / 1000);
	return new SignJWT({
		iss: "https://accounts.google.com",
		aud: CLIENT_ID,
		sub: SUB,
		email: USER.email,
		email_verified: true,
		nonce: NONCE,
		...claims,
	})
		.setProtectedHeader({ alg: "RS256", kid: "google-key", typ: "JWT" })
		.setIssuedAt(options.issuedAt ?? now - 10)
		.setExpirationTime(options.expiresAt ?? now + 3600)
		.sign(options.key ?? signingKey);
}

function cookieHeader(nonce: string | null = NONCE) {
	return nonce === null
		? "other=1"
		: `other=1; ${COOKIE_NAME}=${encodeURIComponent(nonce)}`;
}

function providerIds(options: NextAuthOptions) {
	return options.providers.map(
		(provider) =>
			(provider.options as { id?: string } | undefined)?.id ?? provider.id,
	);
}

beforeEach(() => {
	env.GOOGLE_CLIENT_ID = CLIENT_ID;
	env.GOOGLE_CLIENT_SECRET = "google-secret";
	env.CAP_BLOCKED_SIGNUP_DOMAINS = undefined;
	mocks.linked = [USER];
	mocks.queries = [];
});

describe("verifyGoogleOneTapCredential", () => {
	const verify = (credential: unknown, expectedNonce: string | null = NONCE) =>
		verifyGoogleOneTapCredential({
			credential,
			expectedNonce,
			clientId: CLIENT_ID,
		});

	it("accepts a valid token from either Google issuer", async () => {
		await expect(verify(await token())).resolves.toEqual({
			sub: SUB,
			email: USER.email,
		});
		await expect(
			verify(await token({ iss: "accounts.google.com" })),
		).resolves.toEqual({ sub: SUB, email: USER.email });
	});

	it("rejects a token for another audience", async () => {
		await expect(
			verify(await token({ aud: "attacker.apps.googleusercontent.com" })),
		).resolves.toBeNull();
	});

	it("rejects an audience list even when it contains the client id", async () => {
		await expect(
			verify(
				await token({
					aud: [CLIENT_ID, "attacker.apps.googleusercontent.com"],
				}),
			),
		).resolves.toBeNull();
	});

	it("rejects a token from another issuer", async () => {
		await expect(
			verify(await token({ iss: "https://accounts.google.com.evil.example" })),
		).resolves.toBeNull();
		await expect(
			verify(await token({ iss: "https://login.example.com" })),
		).resolves.toBeNull();
	});

	it("rejects an expired token", async () => {
		const now = Math.floor(Date.now() / 1000);
		await expect(
			verify(await token({}, { issuedAt: now - 7200, expiresAt: now - 3600 })),
		).resolves.toBeNull();
	});

	it("rejects a token issued in the future", async () => {
		const now = Math.floor(Date.now() / 1000);
		await expect(
			verify(await token({}, { issuedAt: now + 600, expiresAt: now + 4200 })),
		).resolves.toBeNull();
	});

	it.each([
		["false", false],
		["missing", undefined],
		["the string true", "true"],
	])("rejects email_verified %s", async (_label, emailVerified) => {
		await expect(
			verify(await token({ email_verified: emailVerified })),
		).resolves.toBeNull();
	});

	it("rejects a nonce that does not match the browser cookie", async () => {
		await expect(
			verify(await token({ nonce: `${NONCE.slice(0, -1)}X` })),
		).resolves.toBeNull();
		await expect(verify(await token({ nonce: undefined }))).resolves.toBeNull();
	});

	it("rejects a token when the nonce cookie is missing", async () => {
		await expect(verify(await token(), null)).resolves.toBeNull();
		await expect(verify(await token(), "")).resolves.toBeNull();
	});

	it("rejects a malformed nonce cookie even when the token repeats it", async () => {
		for (const nonce of ["short", `${"a".repeat(30)};x`, "a".repeat(129)]) {
			await expect(verify(await token({ nonce }), nonce)).resolves.toBeNull();
		}
	});

	it("rejects an azp for another client and accepts our own", async () => {
		await expect(
			verify(await token({ azp: "attacker.apps.googleusercontent.com" })),
		).resolves.toBeNull();
		await expect(verify(await token({ azp: CLIENT_ID }))).resolves.toEqual({
			sub: SUB,
			email: USER.email,
		});
	});

	it("rejects an oversize credential before verifying it", async () => {
		const verifier = vi.fn(mocks.jwks ?? (async () => null));
		const original = mocks.jwks;
		mocks.jwks = verifier;
		const valid = await token();
		const oversize = `${valid}${"A".repeat(
			GOOGLE_ONE_TAP_MAX_CREDENTIAL_LENGTH - valid.length + 1,
		)}`;
		await expect(verify(oversize)).resolves.toBeNull();
		expect(verifier).not.toHaveBeenCalled();
		mocks.jwks = original;
	});

	it("rejects tokens signed by a key Google did not publish", async () => {
		await expect(
			verify(await token({}, { key: otherKey })),
		).resolves.toBeNull();
	});

	it("rejects unsigned and HMAC tokens", async () => {
		const header = (alg: string) =>
			Buffer.from(JSON.stringify({ alg, kid: "google-key" })).toString(
				"base64url",
			);
		const now = Math.floor(Date.now() / 1000);
		const payload = Buffer.from(
			JSON.stringify({
				iss: "https://accounts.google.com",
				aud: CLIENT_ID,
				sub: SUB,
				email: USER.email,
				email_verified: true,
				nonce: NONCE,
				iat: now,
				exp: now + 3600,
			}),
		).toString("base64url");
		await expect(verify(`${header("none")}.${payload}.`)).resolves.toBeNull();
		const hmac = await new SignJWT({
			iss: "https://accounts.google.com",
			aud: CLIENT_ID,
			sub: SUB,
			email: USER.email,
			email_verified: true,
			nonce: NONCE,
		})
			.setProtectedHeader({ alg: "HS256", kid: "google-key" })
			.setIssuedAt()
			.setExpirationTime("1h")
			.sign(new TextEncoder().encode("google-secret"));
		await expect(verify(hmac)).resolves.toBeNull();
	});

	it("rejects non-string and empty credentials", async () => {
		await expect(verify(undefined)).resolves.toBeNull();
		await expect(verify(42)).resolves.toBeNull();
		await expect(verify("")).resolves.toBeNull();
		await expect(verify("not.a.jwt")).resolves.toBeNull();
	});
});

describe("authorizeGoogleOneTap", () => {
	it("signs in the user whose Google account is already linked", async () => {
		await expect(
			authorizeGoogleOneTap(await token(), cookieHeader()),
		).resolves.toEqual({
			id: USER.id,
			email: USER.email,
			name: USER.name,
			image: USER.image,
		});
		expect(mocks.queries).toEqual([
			{
				sql: "(`accounts`.`provider` = ? and `accounts`.`providerAccountId` = ?)",
				params: ["google", SUB],
			},
		]);
	});

	it("returns null when no Google account is linked, even if the email exists", async () => {
		mocks.linked = [
			{ ...USER, provider: "email", providerAccountId: USER.email },
			{ ...USER, provider: "workos", providerAccountId: SUB },
		];
		await expect(
			authorizeGoogleOneTap(await token(), cookieHeader()),
		).resolves.toBeNull();
	});

	it("returns null for a new Google user", async () => {
		mocks.linked = [];
		await expect(
			authorizeGoogleOneTap(await token(), cookieHeader()),
		).resolves.toBeNull();
	});

	it("never touches the database for a token that fails verification", async () => {
		await expect(
			authorizeGoogleOneTap(await token({ aud: "other" }), cookieHeader()),
		).resolves.toBeNull();
		await expect(
			authorizeGoogleOneTap(await token(), cookieHeader(null)),
		).resolves.toBeNull();
		expect(mocks.queries).toEqual([]);
	});

	it("refuses a linked user whose email is blocked", async () => {
		env.CAP_BLOCKED_SIGNUP_DOMAINS = "example.com";
		await expect(
			authorizeGoogleOneTap(await token(), cookieHeader()),
		).resolves.toBeNull();
	});

	it("refuses when Google auth is not configured", async () => {
		env.GOOGLE_CLIENT_SECRET = undefined;
		await expect(
			authorizeGoogleOneTap(await token(), cookieHeader()),
		).resolves.toBeNull();
	});

	it("reads the nonce from the request cookie header in the provider", async () => {
		const { authorize } = GoogleOneTapProvider().options as CredentialsConfig;
		const credential = await token();
		await expect(
			authorize({ credential }, { headers: { cookie: cookieHeader() } }),
		).resolves.toMatchObject({ id: USER.id });
		await expect(
			authorize({ credential }, { headers: {} }),
		).resolves.toBeNull();
		await expect(
			authorize({ credential: "" }, { headers: { cookie: cookieHeader() } }),
		).resolves.toBeNull();
	});
});

describe("readCookie", () => {
	it("finds the exact cookie name only", () => {
		expect(
			readCookie(`x${COOKIE_NAME}=bad; ${COOKIE_NAME}=good`, COOKIE_NAME),
		).toBe("good");
		expect(readCookie(`${COOKIE_NAME}x=bad`, COOKIE_NAME)).toBeNull();
		expect(readCookie(undefined, COOKIE_NAME)).toBeNull();
	});
});

describe("Google One Tap provider registration", () => {
	it("registers the provider only when Google OAuth is configured", () => {
		expect(providerIds(authOptions())).toContain(GOOGLE_ONE_TAP_PROVIDER_ID);

		env.GOOGLE_CLIENT_SECRET = undefined;
		expect(providerIds(authOptions())).not.toContain(
			GOOGLE_ONE_TAP_PROVIDER_ID,
		);

		env.GOOGLE_CLIENT_SECRET = "google-secret";
		env.GOOGLE_CLIENT_ID = undefined;
		expect(providerIds(authOptions())).not.toContain(
			GOOGLE_ONE_TAP_PROVIDER_ID,
		);
	});

	it("blocks a One Tap sign-in for a blocked email in the signIn callback", async () => {
		env.CAP_BLOCKED_SIGNUP_DOMAINS = "example.com";
		const signIn = authOptions().callbacks?.signIn;
		if (!signIn) throw new Error("signIn callback missing");
		await expect(
			signIn({
				user: { id: USER.id, email: USER.email },
				account: {
					provider: GOOGLE_ONE_TAP_PROVIDER_ID,
					providerAccountId: USER.id,
					type: "credentials",
				},
				credentials: { credential: "token" },
			}),
		).resolves.toBe("/login?error=SignupBlocked");
	});
});

describe("Google One Tap nonce route", () => {
	it("issues a random nonce in a short-lived httpOnly cookie", async () => {
		const { POST } = await import("@/app/api/auth/google-one-tap/route");
		const first = await POST();
		const second = await POST();
		expect(first.status).toBe(200);
		expect(first.headers.get("cache-control")).toBe("no-store");
		const { nonce } = (await first.json()) as { nonce: string };
		const { nonce: other } = (await second.json()) as { nonce: string };
		expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(other).not.toBe(nonce);
		const cookie = first.headers.get("set-cookie") ?? "";
		expect(cookie).toContain(`${COOKIE_NAME}=${nonce}`);
		expect(cookie).toContain("Path=/api/auth");
		expect(cookie).toContain("Max-Age=300");
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("Secure");
		expect(cookie.toLowerCase()).toContain("samesite=lax");
	});

	it("is not available when Google auth is not configured", async () => {
		env.GOOGLE_CLIENT_SECRET = undefined;
		const { POST } = await import("@/app/api/auth/google-one-tap/route");
		const response = await POST();
		expect(response.status).toBe(404);
		expect(response.headers.get("set-cookie")).toBeNull();
	});
});
