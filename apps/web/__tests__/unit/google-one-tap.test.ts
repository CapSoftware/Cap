import { authOptions } from "@cap/database/auth/auth-options";
import {
	authorizeGoogleOneTap,
	consumeGoogleOneTapNonce,
	GOOGLE_ONE_TAP_MAX_CREDENTIAL_LENGTH,
	GOOGLE_ONE_TAP_PROVIDER_ID,
	GoogleOneTapProvider,
	googleOneTapNonceForSecret,
	googleOneTapNonceSetCookie,
	issueGoogleOneTapNonce,
	readCookie,
	readGoogleOneTapNonces,
	verifyGoogleOneTapCredential,
} from "@cap/database/auth/google-one-tap";
import type { HttpApi } from "@effect/platform";
import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { Layer as EffectLayer } from "effect";
import {
	createLocalJWKSet,
	exportJWK,
	generateKeyPair,
	type JWTPayload,
	type KeyLike,
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

vi.mock("@/lib/server", async () => {
	const { HttpApiBuilder, HttpServer } = await import("@effect/platform");
	const { Layer } = await import("effect");
	return {
		apiToHandler: (api: EffectLayer.Layer<HttpApi.Api>) => {
			const { handler } = HttpApiBuilder.toWebHandler(
				Layer.mergeAll(api, HttpServer.layerContext),
			);
			return (request: Request) => handler(request);
		},
	};
});

vi.mock("../../../../packages/database/auth/drizzle-adapter", () => ({
	DrizzleAdapter: () => ({}),
}));

vi.mock("../../../../packages/database/auth/disposable-signup", () => ({
	isDisposableEmailSignup: async () => false,
}));

const CLIENT_ID = "cap-web.apps.googleusercontent.com";
const NONCE = "n0nce_value-0123456789abcdefABCDEF0123456";
const GOOGLE_NONCE = googleOneTapNonceForSecret(NONCE);
const COOKIE_NAME = "__Host-cap-google-one-tap";
const SUB = "109876543210987654321";
const USER: LinkedUser = {
	provider: "google",
	providerAccountId: SUB,
	id: "user_linked",
	email: "alex@example.com",
	name: "Alex",
	image: null,
};

let signingKey: KeyLike;
let otherKey: KeyLike;

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
		key?: KeyLike;
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
		nonce: GOOGLE_NONCE,
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
		: `other=1; ${COOKIE_NAME}=${encodeURIComponent(
				`${nonce}.${Math.floor(Date.now() / 1000) - 5}`,
			)}`;
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
	const verify = (
		credential: unknown,
		expectedNonce: string | null = GOOGLE_NONCE,
	) =>
		verifyGoogleOneTapCredential({
			credential,
			expectedNonces: expectedNonce === null ? [] : [expectedNonce],
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
			verify(await token({ nonce: `${GOOGLE_NONCE.slice(0, -1)}X` })),
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

	it("refuses a cookie rebuilt from the nonce inside a stolen token", async () => {
		const stolen = await token();
		const forged = `other=1; ${COOKIE_NAME}=${encodeURIComponent(
			`${GOOGLE_NONCE}.${Math.floor(Date.now() / 1000) - 5}`,
		)}`;
		for (let attempt = 0; attempt < 3; attempt++) {
			await expect(authorizeGoogleOneTap(stolen, forged)).resolves.toBeNull();
		}
		await expect(
			authorizeGoogleOneTap(stolen, cookieHeader()),
		).resolves.toMatchObject({ id: USER.id });
	});

	it("never sends the stored secret to Google", () => {
		const { nonce, cookieValue } = issueGoogleOneTapNonce(null);
		const [entry] = readGoogleOneTapNonces(cookieValue);
		expect(entry).toBeDefined();
		expect(nonce).not.toBe(entry?.nonce);
		expect(cookieValue).not.toContain(nonce);
		expect(nonce).toBe(googleOneTapNonceForSecret(entry?.nonce ?? ""));
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
			}),
		).resolves.toBe("/login?error=SignupBlocked");
	});
});

describe("Google One Tap nonce cookie", () => {
	const NOW = 1_800_000_000_000;
	const nowSeconds = NOW / 1000;
	const other = "0therTabNonce_0123456789abcdefABCDEF0123456";

	it("keeps another tab's outstanding nonce when issuing a new one", async () => {
		const first = issueGoogleOneTapNonce(null, NOW);
		const second = issueGoogleOneTapNonce(first.cookieValue, NOW + 1000);
		const nonces = readGoogleOneTapNonces(second.cookieValue, NOW + 2000).map(
			(entry) => googleOneTapNonceForSecret(entry.nonce),
		);
		expect(nonces).toEqual([first.nonce, second.nonce]);
		for (const nonce of nonces) {
			await expect(
				verifyGoogleOneTapCredential({
					credential: await token({ nonce }),
					expectedNonces: nonces,
					clientId: CLIENT_ID,
				}),
			).resolves.toEqual({ sub: SUB, email: USER.email });
		}
	});

	it("drops nonces older than five minutes or from the future", () => {
		const value = [
			`${NONCE}.${nowSeconds - 300}`,
			`${other}.${nowSeconds - 299}`,
			`${NONCE}.${nowSeconds + 120}`,
		].join(":");
		expect(readGoogleOneTapNonces(value, NOW)).toEqual([
			{ nonce: other, issuedAt: nowSeconds - 299 },
		]);
	});

	it("keeps at most five outstanding nonces", () => {
		let cookieValue: string | null = null;
		const issued: string[] = [];
		for (let i = 0; i < 7; i++) {
			const next = issueGoogleOneTapNonce(cookieValue, NOW + i);
			cookieValue = next.cookieValue;
			issued.push(next.nonce);
		}
		expect(
			readGoogleOneTapNonces(cookieValue, NOW + 10).map((e) =>
				googleOneTapNonceForSecret(e.nonce),
			),
		).toEqual(issued.slice(-5));
	});

	it("reads at most five nonces from a crafted cookie", () => {
		const entries = Array.from(
			{ length: 7 },
			(_, i) => `${NONCE.slice(0, -1)}${i}.${nowSeconds - 10}`,
		);
		expect(
			readGoogleOneTapNonces(entries.join(":"), NOW).map((e) => e.nonce),
		).toEqual(entries.slice(-5).map((entry) => entry.split(".")[0]));
	});

	it("ignores malformed and oversize cookie values", () => {
		expect(readGoogleOneTapNonces(`${NONCE}`, NOW)).toEqual([]);
		expect(readGoogleOneTapNonces(`${NONCE}.1.2`, NOW)).toEqual([]);
		expect(readGoogleOneTapNonces(`bad!.${nowSeconds}`, NOW)).toEqual([]);
		expect(
			readGoogleOneTapNonces(`${NONCE}.${nowSeconds}:${"x".repeat(1100)}`, NOW),
		).toEqual([]);
	});

	it("consumes only the nonce the credential used", async () => {
		const value = `${NONCE}.${nowSeconds - 10}:${other}.${nowSeconds - 5}`;
		const credential = await token();
		expect(consumeGoogleOneTapNonce(value, credential, NOW)).toBe(
			`${other}.${nowSeconds - 5}`,
		);
		expect(
			consumeGoogleOneTapNonce(`${NONCE}.${nowSeconds - 10}`, credential, NOW),
		).toBe("");
		expect(consumeGoogleOneTapNonce(value, "garbage", NOW)).toBe(value);
	});

	it("serializes the cookie and deletes it once empty", () => {
		expect(googleOneTapNonceSetCookie("https://cap.so", "a.1")).toBe(
			`${COOKIE_NAME}=a.1; Path=/; Max-Age=300; HttpOnly; SameSite=Lax; Secure`,
		);
		expect(googleOneTapNonceSetCookie("https://cap.so", "")).toBe(
			`${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`,
		);
		expect(googleOneTapNonceSetCookie("http://localhost:3000", "")).toBe(
			"cap-google-one-tap=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
		);
	});
});

describe("Google One Tap nonce route", () => {
	const post = async (cookie?: string) => {
		const { POST } = await import("@/app/api/auth/google-one-tap/route");
		return POST(
			new Request("https://cap.so/api/auth/google-one-tap", {
				method: "POST",
				headers: cookie ? { cookie } : {},
			}),
		);
	};

	it("issues a random nonce in a short-lived host-only httpOnly cookie", async () => {
		const first = await post();
		expect(first.status).toBe(200);
		expect(first.headers.get("cache-control")).toBe("no-store");
		const { nonce } = (await first.json()) as { nonce: string };
		expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const cookie = first.headers.get("set-cookie") ?? "";
		const [stored] = readGoogleOneTapNonces(readCookie(cookie, COOKIE_NAME));
		expect(stored).toBeDefined();
		expect(cookie).not.toContain(nonce);
		expect(googleOneTapNonceForSecret(stored?.nonce ?? "")).toBe(nonce);
		expect(cookie).toContain("Path=/;");
		expect(cookie).toContain("Max-Age=300");
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("Secure");
		expect(cookie).not.toContain("Domain");
		expect(cookie.toLowerCase()).toContain("samesite=lax");

		const second = await post(cookie.split(";")[0]);
		const { nonce: next } = (await second.json()) as { nonce: string };
		expect(next).not.toBe(nonce);
		const value = readCookie(second.headers.get("set-cookie"), COOKIE_NAME);
		expect(
			readGoogleOneTapNonces(value).map((e) =>
				googleOneTapNonceForSecret(e.nonce),
			),
		).toEqual([nonce, next]);
	});

	it("is not available when Google auth is not configured", async () => {
		env.GOOGLE_CLIENT_SECRET = undefined;
		const response = await post();
		expect(response.status).toBe(404);
		expect(response.headers.get("set-cookie")).toBeNull();
	});
});
