import nodeCrypto, {
	createHash,
	generateKeyPairSync,
	type KeyObject,
	randomBytes,
	randomUUID,
	sign,
	webcrypto,
} from "node:crypto";
import {
	agentApiAuthorizationCodes,
	authChallenges,
	mcpOAuthClients,
	mcpOAuthCodes,
	mcpOAuthTokens,
	userPasskeys,
	users,
} from "@cap/database/schema";
import { Organisation, User } from "@cap/web-domain";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { createPool, type Pool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	hasStepUpGrant,
	issueStepUpCode,
	issueStepUpGrant,
	STEP_UP_CODE_MAX_ATTEMPTS,
	STEP_UP_CODES_PER_DAY,
	storeChallenge,
	verifyStepUpCode,
} from "../../../../packages/database/auth/auth-challenges";
import {
	createPasskeyRegistrationOptions,
	createPasskeySignInOptions,
	createPasskeyStepUpOptions,
	deletePasskey,
	listPasskeys,
	MAX_PASSKEYS_PER_USER,
	verifyPasskeyRegistration,
	verifyPasskeySignIn,
	verifyPasskeyStepUp,
} from "../../../../packages/database/auth/passkeys";

const RP_ID = "cap.test";
const ORIGIN = "https://cap.test";

const fixture = vi.hoisted(() => ({
	database: undefined as MySql2Database | undefined,
	env: {
		WEB_URL: "https://cap.test",
		NEXTAUTH_SECRET: "passkeys-database-test-secret-0123456789",
		CAP_BLOCKED_SIGNUP_DOMAINS: "blocked.test",
		GOOGLE_CLIENT_ID: "google-client",
		GOOGLE_CLIENT_SECRET: "google-secret",
	} as Record<string, string | undefined>,
	currentUser: null as unknown,
	session: null as unknown,
	securityCodes: [] as { email: string; code: string }[],
	passkeyNotices: [] as { email: string; name: string }[],
	removedNotices: [] as { email: string; name: string }[],
	afterRegistrationVerify: null as null | (() => Promise<void>),
}));

vi.mock("@cap/database", () => ({
	db: () => {
		if (!fixture.database) throw new Error("Test database is not connected.");
		return fixture.database;
	},
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => fixture.env,
	buildEnv: { NEXT_PUBLIC_IS_CAP: "false" },
}));

vi.mock("@simplewebauthn/server", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("@simplewebauthn/server")>();
	return {
		...original,
		verifyRegistrationResponse: async (
			...args: Parameters<typeof original.verifyRegistrationResponse>
		) => {
			const result = await original.verifyRegistrationResponse(...args);
			const hook = fixture.afterRegistrationVerify;
			fixture.afterRegistrationVerify = null;
			await hook?.();
			return result;
		},
	};
});
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => fixture.currentUser,
	getSession: async () => fixture.session,
}));
vi.mock("server-only", () => ({}));
vi.mock("@cap/database/auth/security-emails", () => ({
	sendAccountSecurityCode: async (email: string, code: string) => {
		fixture.securityCodes.push({ email, code });
	},
	sendPasskeyAddedNotice: async (email: string, name: string) => {
		fixture.passkeyNotices.push({ email, name });
	},
	sendPasskeyRemovedNotice: async (email: string, name: string) => {
		fixture.removedNotices.push({ email, name });
	},
}));
vi.mock("@/lib/rate-limit", () => ({
	isRateLimited: async () => false,
	RATE_LIMIT_IDS: {
		AUTH_PASSKEY: "rl_auth_passkey",
		AUTH_OTP_SEND: "rl_auth_otp_send",
		AUTH_OTP_VERIFY: "rl_auth_otp_verify",
	},
}));

const databaseUrl = process.env.CAP_PASSKEYS_TEST_DATABASE_URL;

const UP = 0x01;
const UV = 0x04;
const BE = 0x08;
const BS = 0x10;
const AT = 0x40;
const ICLOUD_AAGUID = "fbfc3007-154e-4ecc-8c0b-6e020557d7bd";

function database() {
	if (!fixture.database) throw new Error("Test database is not connected.");
	return fixture.database;
}

function id() {
	return randomUUID().replaceAll("-", "").slice(0, 15);
}

function b64url(bytes: Uint8Array | Buffer | string) {
	return Buffer.from(bytes).toString("base64url");
}

function uint32(value: number) {
	const buffer = Buffer.alloc(4);
	buffer.writeUInt32BE(value);
	return buffer;
}

function clientData(
	type: string,
	challenge: string,
	origin: string,
	extra: Record<string, unknown> = {},
) {
	return Buffer.from(
		JSON.stringify({ type, challenge, origin, crossOrigin: false, ...extra }),
	);
}

class SoftwareAuthenticator {
	readonly credentialId = b64url(randomBytes(32));
	private readonly keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
	counter = 0;

	constructor(readonly userId?: string) {}

	private cosePublicKey() {
		const jwk = this.keys.publicKey.export({ format: "jwk" });
		return isoCBOR.encode(
			new Map<number, number | Uint8Array>([
				[1, 2],
				[3, -7],
				[-1, 1],
				[-2, Buffer.from(jwk.x as string, "base64url")],
				[-3, Buffer.from(jwk.y as string, "base64url")],
			]),
		);
	}

	register(
		challenge: string,
		options: {
			origin?: string;
			rpId?: string;
			flags?: number;
			fmt?: string;
			attStmt?: Map<string, unknown>;
		} = {},
	) {
		const flags = options.flags ?? UP | UV | BE | BS | AT;
		const credentialId = Buffer.from(this.credentialId, "base64url");
		const length = Buffer.alloc(2);
		length.writeUInt16BE(credentialId.length);
		const authData = Buffer.concat([
			createHash("sha256")
				.update(options.rpId ?? RP_ID)
				.digest(),
			Buffer.from([flags]),
			uint32(this.counter),
			Buffer.from(ICLOUD_AAGUID.replaceAll("-", ""), "hex"),
			length,
			credentialId,
			Buffer.from(this.cosePublicKey()),
		]);
		const attestationObject = isoCBOR.encode(
			new Map<string, unknown>([
				["fmt", options.fmt ?? "none"],
				["attStmt", options.attStmt ?? new Map<string, never>()],
				["authData", authData],
			]) as Parameters<typeof isoCBOR.encode>[0],
		);
		return {
			id: this.credentialId,
			rawId: this.credentialId,
			type: "public-key",
			response: {
				clientDataJSON: b64url(
					clientData("webauthn.create", challenge, options.origin ?? ORIGIN),
				),
				attestationObject: b64url(attestationObject),
				transports: ["internal", "hybrid"],
			},
			clientExtensionResults: {},
		};
	}

	assert(
		challenge: string,
		options: {
			origin?: string;
			rpId?: string;
			flags?: number;
			counter?: number;
			userHandle?: string | null;
			signingKey?: KeyObject;
			credentialId?: string;
			type?: string;
			clientData?: Record<string, unknown>;
		} = {},
	) {
		const counter = options.counter ?? this.counter;
		const authData = Buffer.concat([
			createHash("sha256")
				.update(options.rpId ?? RP_ID)
				.digest(),
			Buffer.from([options.flags ?? UP | UV | BE | BS]),
			uint32(counter),
		]);
		const data = clientData(
			options.type ?? "webauthn.get",
			challenge,
			options.origin ?? ORIGIN,
			options.clientData,
		);
		const signature = sign(
			"sha256",
			Buffer.concat([authData, createHash("sha256").update(data).digest()]),
			options.signingKey ?? this.keys.privateKey,
		);
		const userHandle =
			options.userHandle === undefined
				? this.userId && b64url(this.userId)
				: options.userHandle;
		const credentialId = options.credentialId ?? this.credentialId;
		return JSON.stringify({
			id: credentialId,
			rawId: credentialId,
			type: "public-key",
			response: {
				clientDataJSON: b64url(data),
				authenticatorData: b64url(authData),
				signature: b64url(signature),
				...(userHandle ? { userHandle } : {}),
			},
			clientExtensionResults: {},
		});
	}
}

async function makeUser(email = `${id()}@example.com`) {
	const userId = User.UserId.make(id());
	await database()
		.insert(users)
		.values({
			id: userId,
			email,
			name: "Passkey",
			activeOrganizationId: Organisation.OrganisationId.make(id()),
		});
	createdUsers.push(userId);
	const [row] = await database()
		.select()
		.from(users)
		.where(eq(users.id, userId));
	if (!row) throw new Error("User was not created.");
	return row;
}

async function reloadUser(userId: User.UserId) {
	const [row] = await database()
		.select()
		.from(users)
		.where(eq(users.id, userId));
	if (!row) throw new Error("User was not found.");
	return row;
}

async function registerPasskey(
	user: Awaited<ReturnType<typeof makeUser>>,
	authenticator = new SoftwareAuthenticator(user.id),
) {
	const options = await createPasskeyRegistrationOptions(user);
	if (!options) throw new Error("Registration options were refused.");
	const result = await verifyPasskeyRegistration(
		user.id,
		JSON.stringify(authenticator.register(options.challenge)),
	);
	expect(result.status).toBe("registered");
	return authenticator;
}

async function signInChallenge() {
	return (await createPasskeySignInOptions()).challenge;
}

const createdUsers: User.UserId[] = [];

describe.runIf(Boolean(databaseUrl))(
	"Passkeys with an isolated MySQL database",
	() => {
		let pool: Pool | undefined;

		beforeAll(async () => {
			if (!databaseUrl) throw new Error("Missing isolated test database URL.");
			const url = new URL(databaseUrl);
			if (
				url.protocol !== "mysql:" ||
				!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
				!/^\/cap_(passkeys|infra)_[a-z0-9_]+$/.test(url.pathname)
			) {
				throw new Error(
					"Passkey tests require a session-scoped local database.",
				);
			}
			pool = createPool({ uri: databaseUrl, connectionLimit: 10 });
			fixture.database = drizzle(pool) as unknown as MySql2Database;
		});

		afterAll(async () => {
			if (fixture.database && createdUsers.length > 0) {
				await database()
					.delete(userPasskeys)
					.where(inArray(userPasskeys.userId, createdUsers));
				await database()
					.delete(authChallenges)
					.where(inArray(authChallenges.userId, createdUsers));
				await database().delete(users).where(inArray(users.id, createdUsers));
			}
			await pool?.end();
		});

		describe("registration", () => {
			it("stores a verified passkey with its provider name", async () => {
				const user = await makeUser();
				const authenticator = await registerPasskey(user);
				const [stored] = await database()
					.select()
					.from(userPasskeys)
					.where(eq(userPasskeys.userId, user.id));
				expect(stored?.credentialId).toBe(authenticator.credentialId);
				expect(stored?.name).toBe("iCloud Keychain");
				expect(stored?.backedUp).toBe(true);
				expect(stored?.transports).toEqual(["internal", "hybrid"]);
			});

			it("uses each registration challenge once", async () => {
				const user = await makeUser();
				const options = await createPasskeyRegistrationOptions(user);
				if (!options) throw new Error("Missing options.");
				const response = JSON.stringify(
					new SoftwareAuthenticator(user.id).register(options.challenge),
				);
				expect(
					(await verifyPasskeyRegistration(user.id, response)).status,
				).toBe("registered");
				expect(
					(await verifyPasskeyRegistration(user.id, response)).status,
				).toBe("invalid");
			});

			it("refuses another user's registration challenge without spending it", async () => {
				const owner = await makeUser();
				const attacker = await makeUser();
				const options = await createPasskeyRegistrationOptions(owner);
				if (!options) throw new Error("Missing options.");
				const response = JSON.stringify(
					new SoftwareAuthenticator(attacker.id).register(options.challenge),
				);
				expect(
					(await verifyPasskeyRegistration(attacker.id, response)).status,
				).toBe("invalid");
				expect(await listPasskeys(attacker.id)).toHaveLength(0);
				expect(
					(await verifyPasskeyRegistration(owner.id, response)).status,
				).toBe("registered");
			});

			it("refuses a sign-in challenge as a registration challenge", async () => {
				const user = await makeUser();
				const response = JSON.stringify(
					new SoftwareAuthenticator(user.id).register(await signInChallenge()),
				);
				expect(
					(await verifyPasskeyRegistration(user.id, response)).status,
				).toBe("invalid");
			});

			it("refuses a check-it's-you challenge as a registration challenge", async () => {
				const user = await makeUser();
				await registerPasskey(user);
				const stepUp = await createPasskeyStepUpOptions(user.id);
				if (!stepUp) throw new Error("Missing options.");
				const response = JSON.stringify(
					new SoftwareAuthenticator(user.id).register(stepUp.challenge),
				);
				expect(
					(await verifyPasskeyRegistration(user.id, response)).status,
				).toBe("invalid");
				expect(await listPasskeys(user.id)).toHaveLength(1);
			});

			it.each([
				["another origin", { origin: "https://evil.test" }],
				["another relying party", { rpId: "evil.test" }],
				["no user verification", { flags: UP | AT }],
			])("refuses a credential created for %s", async (_, options) => {
				const user = await makeUser();
				const registration = await createPasskeyRegistrationOptions(user);
				if (!registration) throw new Error("Missing options.");
				const response = JSON.stringify(
					new SoftwareAuthenticator(user.id).register(
						registration.challenge,
						options,
					),
				);
				expect(
					(await verifyPasskeyRegistration(user.id, response)).status,
				).toBe("invalid");
				expect(await listPasskeys(user.id)).toHaveLength(0);
			});

			it("refuses a credential that is already registered to anyone", async () => {
				const owner = await makeUser();
				const other = await makeUser();
				const authenticator = await registerPasskey(owner);
				const options = await createPasskeyRegistrationOptions(other);
				if (!options) throw new Error("Missing options.");
				expect(
					(
						await verifyPasskeyRegistration(
							other.id,
							JSON.stringify(authenticator.register(options.challenge)),
						)
					).status,
				).toBe("duplicate");
			});

			it(`caps each account at ${MAX_PASSKEYS_PER_USER} passkeys`, async () => {
				const user = await makeUser();
				for (let index = 0; index < MAX_PASSKEYS_PER_USER; index++) {
					await registerPasskey(user);
				}
				expect(await listPasskeys(user.id)).toHaveLength(MAX_PASSKEYS_PER_USER);
				expect(await createPasskeyRegistrationOptions(user)).toBeNull();
			});

			it("adds one passkey per setup even when several registrations race", async () => {
				const user = await makeUser();
				const responses = [];
				for (let index = 0; index < 4; index++) {
					const options = await createPasskeyRegistrationOptions(user);
					if (!options) throw new Error("Missing options.");
					responses.push(
						JSON.stringify(
							new SoftwareAuthenticator(user.id).register(options.challenge),
						),
					);
				}
				const results = await Promise.all(
					responses.map((response) =>
						verifyPasskeyRegistration(user.id, response),
					),
				);
				expect(
					results.filter((result) => result.status === "registered"),
				).toHaveLength(1);
				expect(await listPasskeys(user.id)).toHaveLength(1);
			});

			it("ignores attestation statements and never fetches their certificate URLs", async () => {
				const x509 = await import("@peculiar/x509");
				x509.cryptoProvider.set(webcrypto as unknown as Crypto);
				const keys = await webcrypto.subtle.generateKey(
					{ name: "ECDSA", namedCurve: "P-256" },
					true,
					["sign", "verify"],
				);
				const certificate =
					await x509.X509CertificateGenerator.createSelfSigned({
						serialNumber: "01",
						name: "CN=probe",
						notBefore: new Date(Date.now() - 60_000),
						notAfter: new Date(Date.now() + 86_400_000),
						signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
						keys,
						extensions: [
							new x509.CRLDistributionPointsExtension([
								"http://169.254.169.254/latest/meta-data/probe",
							]),
						],
					});
				const fetchSpy = vi
					.spyOn(globalThis, "fetch")
					.mockResolvedValue(new Response(new Uint8Array(0)));
				try {
					for (const fmt of ["apple", "packed", "android-key"]) {
						const user = await makeUser();
						const options = await createPasskeyRegistrationOptions(user);
						if (!options) throw new Error("Missing options.");
						const response = new SoftwareAuthenticator(user.id).register(
							options.challenge,
							{
								fmt,
								attStmt: new Map<string, unknown>([
									["alg", -7],
									["sig", new Uint8Array(64)],
									["x5c", [new Uint8Array(certificate.rawData)]],
								]),
							},
						);
						expect(
							(
								await verifyPasskeyRegistration(
									user.id,
									JSON.stringify(response),
								)
							).status,
						).toBe("registered");
					}
					expect(fetchSpy).not.toHaveBeenCalled();
				} finally {
					fetchSpy.mockRestore();
				}
			});

			it("rejects malformed and oversized responses", async () => {
				const user = await makeUser();
				for (const raw of [
					"",
					"{",
					"null",
					"[]",
					JSON.stringify({ id: "a", rawId: "b", type: "public-key" }),
					"x".repeat(20_000),
				]) {
					expect((await verifyPasskeyRegistration(user.id, raw)).status).toBe(
						"invalid",
					);
				}
				const options = await createPasskeyRegistrationOptions(user);
				if (!options) throw new Error("Missing options.");
				expect(
					(
						await verifyPasskeyRegistration(
							user.id,
							new SoftwareAuthenticator(user.id).register(options.challenge),
						)
					).status,
				).toBe("invalid");
			});
		});

		describe("sign-in", () => {
			it("signs in the passkey's owner and records use", async () => {
				const user = await makeUser();
				const authenticator = await registerPasskey(user);
				const signedIn = await verifyPasskeySignIn(
					authenticator.assert(await signInChallenge(), { counter: 3 }),
				);
				expect(signedIn?.id).toBe(user.id);
				const [stored] = await database()
					.select()
					.from(userPasskeys)
					.where(eq(userPasskeys.userId, user.id));
				expect(stored?.counter).toBe(3);
				expect(stored?.lastUsedAt).toBeInstanceOf(Date);
			});

			it("accepts each assertion once", async () => {
				const user = await makeUser();
				const authenticator = await registerPasskey(user);
				const assertion = authenticator.assert(await signInChallenge());
				const results = await Promise.all([
					verifyPasskeySignIn(assertion),
					verifyPasskeySignIn(assertion),
					verifyPasskeySignIn(assertion),
				]);
				expect(results.filter(Boolean)).toHaveLength(1);
				expect(await verifyPasskeySignIn(assertion)).toBeNull();
			});

			it("refuses a challenge it never issued", async () => {
				const user = await makeUser();
				const authenticator = await registerPasskey(user);
				expect(
					await verifyPasskeySignIn(
						authenticator.assert(b64url(randomBytes(32))),
					),
				).toBeNull();
			});

			it("refuses an expired challenge", async () => {
				const user = await makeUser();
				const authenticator = await registerPasskey(user);
				const challenge = await signInChallenge();
				await database()
					.update(authChallenges)
					.set({ expiresAt: new Date(Date.now() - 1000) })
					.where(
						eq(
							authChallenges.secretHash,
							createHash("sha256")
								.update(`passkey_sign_in:${challenge}`)
								.digest("hex"),
						),
					);
				expect(
					await verifyPasskeySignIn(authenticator.assert(challenge)),
				).toBeNull();
			});

			it("refuses challenges issued for registration or for a check", async () => {
				const user = await makeUser();
				const authenticator = await registerPasskey(user);
				const registration = await createPasskeyRegistrationOptions(user);
				const stepUp = await createPasskeyStepUpOptions(user.id);
				if (!registration || !stepUp) throw new Error("Missing options.");
				expect(
					await verifyPasskeySignIn(
						authenticator.assert(registration.challenge),
					),
				).toBeNull();
				expect(
					await verifyPasskeySignIn(authenticator.assert(stepUp.challenge)),
				).toBeNull();
			});

			it.each([
				["another origin", { origin: "https://evil.test" }],
				["a subdomain origin", { origin: "https://evil.cap.test" }],
				["another relying party", { rpId: "evil.test" }],
				["no user verification", { flags: UP }],
				["no user presence", { flags: UV }],
				["a registration ceremony", { type: "webauthn.create" }],
				["a cross-origin iframe", { clientData: { crossOrigin: true } }],
				[
					"an embedding top origin",
					{ clientData: { topOrigin: "https://evil.test" } },
				],
				["no user handle", { userHandle: null }],
			])("refuses an assertion made for %s", async (_, options) => {
				const user = await makeUser();
				const authenticator = await registerPasskey(user);
				expect(
					await verifyPasskeySignIn(
						authenticator.assert(await signInChallenge(), options),
					),
				).toBeNull();
			});

			it("refuses a signature from a key that is not the stored one", async () => {
				const user = await makeUser();
				const authenticator = await registerPasskey(user);
				const attackerKey = generateKeyPairSync("ec", {
					namedCurve: "P-256",
				}).privateKey;
				expect(
					await verifyPasskeySignIn(
						authenticator.assert(await signInChallenge(), {
							signingKey: attackerKey,
						}),
					),
				).toBeNull();
			});

			it("refuses an assertion whose user handle names another account", async () => {
				const user = await makeUser();
				const other = await makeUser();
				const authenticator = await registerPasskey(user);
				expect(
					await verifyPasskeySignIn(
						authenticator.assert(await signInChallenge(), {
							userHandle: b64url(other.id),
						}),
					),
				).toBeNull();
			});

			it("matches credential ids exactly despite the case-insensitive collation", async () => {
				const user = await makeUser();
				const authenticator = await registerPasskey(user);
				const flipped = authenticator.credentialId.replace(/[a-z]/, (letter) =>
					letter.toUpperCase(),
				);
				expect(flipped).not.toBe(authenticator.credentialId);
				expect(
					await verifyPasskeySignIn(
						authenticator.assert(await signInChallenge(), {
							credentialId: flipped,
						}),
					),
				).toBeNull();
			});

			it("keeps the highest counter when sign-ins race", async () => {
				const user = await makeUser();
				const authenticator = await registerPasskey(user);
				const counters = [4, 9, 1, 12, 7, 3, 10, 2, 8, 5, 11, 6];
				const assertions = [];
				for (const counter of counters) {
					assertions.push(
						authenticator.assert(await signInChallenge(), { counter }),
					);
				}
				const results = await Promise.all(
					assertions.map((assertion) => verifyPasskeySignIn(assertion)),
				);
				expect(results[counters.indexOf(12)]?.id).toBe(user.id);
				const [stored] = await database()
					.select({ counter: userPasskeys.counter })
					.from(userPasskeys)
					.where(eq(userPasskeys.userId, user.id));
				expect(stored?.counter).toBe(12);
			});

			it("refuses a counter that went backwards", async () => {
				const user = await makeUser();
				const authenticator = await registerPasskey(user);
				expect(
					await verifyPasskeySignIn(
						authenticator.assert(await signInChallenge(), { counter: 10 }),
					),
				).not.toBeNull();
				expect(
					await verifyPasskeySignIn(
						authenticator.assert(await signInChallenge(), { counter: 5 }),
					),
				).toBeNull();
			});

			it("stops working once removed or once its account is gone", async () => {
				const user = await makeUser();
				const authenticator = await registerPasskey(user);
				const [stored] = await listPasskeys(user.id);
				if (!stored) throw new Error("Missing passkey.");
				const other = await makeUser();
				expect(await deletePasskey(other.id, stored.id)).toBeNull();
				expect(await deletePasskey(user.id, stored.id)).toEqual({
					name: "iCloud Keychain",
				});
				expect(
					await verifyPasskeySignIn(
						authenticator.assert(await signInChallenge()),
					),
				).toBeNull();

				const gone = await makeUser();
				const goneAuthenticator = await registerPasskey(gone);
				await database().delete(users).where(eq(users.id, gone.id));
				expect(
					await verifyPasskeySignIn(
						goneAuthenticator.assert(await signInChallenge()),
					),
				).toBeNull();
			});

			it("signs in through the NextAuth provider, and the blocklist still applies", async () => {
				const { authOptions } = await import(
					"../../../../packages/database/auth/auth-options"
				);
				const options = authOptions();
				const provider = options.providers.find(
					(entry) =>
						(entry as { options?: { id?: string } }).options?.id === "passkey",
				) as unknown as {
					options: {
						authorize: (
							credentials: Record<string, unknown>,
						) => Promise<{ id: string; email: string } | null>;
					};
				};
				const user = await makeUser();
				const authenticator = await registerPasskey(user);
				const signedIn = await provider.options.authorize({
					response: authenticator.assert(await signInChallenge()),
				});
				expect(signedIn).toMatchObject({ id: user.id, email: user.email });
				expect(await provider.options.authorize({ response: "{}" })).toBeNull();
				expect(await provider.options.authorize({})).toBeNull();

				const blocked = await makeUser(`${id()}@blocked.test`);
				const blockedAuthenticator = await registerPasskey(blocked);
				const blockedUser = await provider.options.authorize({
					response: blockedAuthenticator.assert(await signInChallenge()),
				});
				expect(blockedUser?.id).toBe(blocked.id);
				const callback = options.callbacks?.signIn;
				if (!callback || !blockedUser) throw new Error("Missing callback.");
				expect(
					await callback({
						user: { ...blockedUser, emailVerified: null },
						account: {
							provider: "passkey",
							type: "credentials",
							providerAccountId: blockedUser.id,
						},
						credentials: {},
					}),
				).toBe("/login?error=SignupBlocked");
			});
		});

		describe("server actions", () => {
			async function actions() {
				return import("@/actions/auth/passkeys");
			}

			it("refuses to start registration without a confirmation for this account", async () => {
				const {
					getPasskeyRegistrationOptions,
					sendSecurityCode,
					verifySecurityCode,
				} = await actions();
				const user = await makeUser();
				const other = await makeUser();
				fixture.currentUser = user;
				expect(await getPasskeyRegistrationOptions("")).toEqual({
					status: "verify",
				});
				expect(
					await getPasskeyRegistrationOptions(b64url(randomBytes(32))),
				).toEqual({ status: "verify" });

				fixture.currentUser = other;
				expect(await sendSecurityCode()).toEqual({ status: "sent" });
				const otherCode = fixture.securityCodes.at(-1);
				expect(otherCode?.email).toBe(other.email);
				const otherGrant = await verifySecurityCode(otherCode?.code ?? "");
				if (otherGrant.status !== "ok") throw new Error("No grant.");
				fixture.currentUser = user;
				expect(await getPasskeyRegistrationOptions(otherGrant.grant)).toEqual({
					status: "verify",
				});
				expect(await verifySecurityCode(otherCode?.code ?? "")).toEqual({
					status: "invalid",
				});

				const expired = await issueStepUpGrant(user.id);
				await database()
					.update(authChallenges)
					.set({ expiresAt: new Date(Date.now() - 1000) })
					.where(
						eq(
							authChallenges.secretHash,
							createHash("sha256")
								.update(`step_up_grant:${expired}`)
								.digest("hex"),
						),
					);
				expect(await getPasskeyRegistrationOptions(expired)).toEqual({
					status: "verify",
				});
				expect(await listPasskeys(user.id)).toHaveLength(0);
			});

			it("adds a passkey after an emailed code, and tells the account", async () => {
				const {
					completePasskeyRegistration,
					getPasskeyRegistrationOptions,
					listMyPasskeys,
					sendSecurityCode,
					verifySecurityCode,
				} = await actions();
				const user = await makeUser();
				fixture.currentUser = user;
				expect(await verifySecurityCode("123456")).toEqual({
					status: "invalid",
				});
				expect(await sendSecurityCode()).toEqual({ status: "sent" });
				expect((await sendSecurityCode()).status).toBe("cooldown");
				const sent = fixture.securityCodes.at(-1);
				expect(sent?.email).toBe(user.email);
				const confirmed = await verifySecurityCode(sent?.code ?? "");
				if (confirmed.status !== "ok") throw new Error("No grant.");
				const options = await getPasskeyRegistrationOptions(confirmed.grant);
				if (options.status !== "ok") throw new Error("No options.");
				expect(options.options.authenticatorSelection).toMatchObject({
					residentKey: "required",
					userVerification: "required",
				});
				expect(options.options.rp.id).toBe(RP_ID);
				const authenticator = new SoftwareAuthenticator(user.id);
				const result = await completePasskeyRegistration(
					JSON.stringify(authenticator.register(options.options.challenge)),
				);
				expect(result.status).toBe("registered");
				expect(fixture.passkeyNotices.at(-1)).toEqual({
					email: user.email,
					name: "iCloud Keychain",
				});
				expect(await listMyPasskeys()).toHaveLength(1);
				expect(await getPasskeyRegistrationOptions(confirmed.grant)).toEqual({
					status: "verify",
				});
			});

			it("lets one confirmation add only one passkey", async () => {
				const {
					completePasskeyRegistration,
					getPasskeyRegistrationOptions,
					sendSecurityCode,
					verifySecurityCode,
				} = await actions();
				const user = await makeUser();
				fixture.currentUser = user;
				expect(await sendSecurityCode()).toEqual({ status: "sent" });
				const confirmed = await verifySecurityCode(
					fixture.securityCodes.at(-1)?.code ?? "",
				);
				if (confirmed.status !== "ok") throw new Error("No grant.");
				const first = await getPasskeyRegistrationOptions(confirmed.grant);
				const second = await getPasskeyRegistrationOptions(confirmed.grant);
				if (first.status !== "ok" || second.status !== "ok") {
					throw new Error("No options.");
				}
				expect(
					(
						await completePasskeyRegistration(
							JSON.stringify(
								new SoftwareAuthenticator(user.id).register(
									first.options.challenge,
								),
							),
						)
					).status,
				).toBe("registered");
				expect(
					(
						await completePasskeyRegistration(
							JSON.stringify(
								new SoftwareAuthenticator(user.id).register(
									second.options.challenge,
								),
							),
						)
					).status,
				).toBe("invalid");
				expect(await getPasskeyRegistrationOptions(confirmed.grant)).toEqual({
					status: "verify",
				});
				expect(await listPasskeys(user.id)).toHaveLength(1);
			});

			it("confirms with an existing passkey and nobody else's", async () => {
				const { getPasskeyStepUpOptions, verifyPasskeyForStepUp } =
					await actions();
				const user = await makeUser();
				const other = await makeUser();
				const authenticator = await registerPasskey(user);
				const otherAuthenticator = await registerPasskey(other);
				fixture.currentUser = user;
				const options = await getPasskeyStepUpOptions();
				if (options.status !== "ok") throw new Error("No options.");
				expect(
					await verifyPasskeyForStepUp(
						otherAuthenticator.assert(options.options.challenge),
					),
				).toEqual({ status: "invalid" });
				const retry = await getPasskeyStepUpOptions();
				if (retry.status !== "ok") throw new Error("No options.");
				const confirmed = await verifyPasskeyForStepUp(
					authenticator.assert(retry.options.challenge),
				);
				expect(confirmed.status).toBe("ok");
			});

			it("removes a passkey only after confirming it's you, and only your own", async () => {
				const { removePasskey } = await actions();
				const user = await makeUser();
				const other = await makeUser();
				await registerPasskey(other);
				const [otherPasskey] = await listPasskeys(other.id);
				if (!otherPasskey) throw new Error("Missing passkey.");
				const noticesBefore = fixture.removedNotices.length;

				fixture.currentUser = user;
				const userGrant = await issueStepUpGrant(user.id);
				expect(await removePasskey(otherPasskey.id, userGrant)).toEqual({
					status: "missing",
				});

				fixture.currentUser = other;
				expect(await removePasskey(otherPasskey.id, "")).toEqual({
					status: "verify",
				});
				expect(await removePasskey(otherPasskey.id, userGrant)).toEqual({
					status: "verify",
				});
				expect(await listPasskeys(other.id)).toHaveLength(1);
				expect(fixture.removedNotices).toHaveLength(noticesBefore);

				const otherGrant = await issueStepUpGrant(other.id);
				expect(await removePasskey(otherPasskey.id, otherGrant)).toEqual({
					status: "removed",
				});
				expect(await listPasskeys(other.id)).toHaveLength(0);
				expect(fixture.removedNotices.at(-1)).toEqual({
					email: other.email,
					name: "iCloud Keychain",
				});
			});

			it("makes passkeys added without a code sign-in only", async () => {
				const {
					completePasskeyRegistration,
					getPasskeyRegistrationOptionsAfterSignIn,
					getPasskeyStepUpOptions,
					verifyPasskeyForStepUp,
				} = await actions();
				const { startEmailChange } = await import(
					"@/actions/auth/email-change"
				);
				const user = await makeUser();
				fixture.currentUser = user;
				fixture.session = {
					user: { id: user.id },
					authMethod: "email",
					authTime: Math.floor(Date.now() / 1000) - 30,
				};
				const options = await getPasskeyRegistrationOptionsAfterSignIn();
				if (options.status !== "ok") throw new Error("No options.");
				const attacker = new SoftwareAuthenticator(user.id);
				expect(
					(
						await completePasskeyRegistration(
							JSON.stringify(attacker.register(options.options.challenge)),
						)
					).status,
				).toBe("registered");
				const [stored] = await listPasskeys(user.id);
				expect(stored?.confirmsIdentity).toBe(false);

				expect(
					(await verifyPasskeySignIn(attacker.assert(await signInChallenge())))
						?.id,
				).toBe(user.id);

				expect(await getPasskeyStepUpOptions()).toEqual({ status: "none" });
				const forced = await createPasskeyStepUpOptions(user.id);
				expect(forced).toBeNull();
				const smuggled = b64url(randomBytes(32));
				await storeChallenge({
					purpose: "passkey_step_up",
					challenge: smuggled,
					userId: user.id,
				});
				expect(await verifyPasskeyForStepUp(attacker.assert(smuggled))).toEqual(
					{ status: "invalid" },
				);
				expect(
					await startEmailChange("", `attacker-${id()}@example.com`),
				).toEqual({ status: "verify" });

				const confirmed = await issueStepUpGrant(user.id);
				const settingsOptions = await createPasskeyRegistrationOptions(user);
				if (!settingsOptions) throw new Error("No options.");
				expect(
					(
						await verifyPasskeyRegistration(
							user.id,
							JSON.stringify(
								new SoftwareAuthenticator(user.id).register(
									settingsOptions.challenge,
								),
							),
						)
					).status,
				).toBe("registered");
				expect(typeof confirmed).toBe("string");
				const stepUp = await createPasskeyStepUpOptions(user.id);
				expect(stepUp?.allowCredentials).toHaveLength(1);
				expect(stepUp?.allowCredentials?.[0]?.id).not.toBe(
					attacker.credentialId,
				);
			});

			it("closes the no-code route once the sign-in is no longer fresh", async () => {
				const {
					completePasskeyRegistration,
					getPasskeyRegistrationOptionsAfterSignIn,
				} = await actions();
				const user = await makeUser();
				fixture.currentUser = user;
				const now = Math.floor(Date.now() / 1000);
				fixture.session = {
					user: { id: user.id },
					authMethod: "email",
					authTime: now - 30,
				};
				const options = await getPasskeyRegistrationOptionsAfterSignIn();
				if (options.status !== "ok") throw new Error("No options.");
				fixture.session = {
					user: { id: user.id },
					authMethod: "email",
					authTime: now - 11 * 60,
				};
				expect(
					(
						await completePasskeyRegistration(
							JSON.stringify(
								new SoftwareAuthenticator(user.id).register(
									options.options.challenge,
								),
							),
						)
					).status,
				).toBe("invalid");
				expect(await listPasskeys(user.id)).toHaveLength(0);
			});

			it("refuses a no-code passkey once the account has one, even if a setup survived", async () => {
				const user = await makeUser();
				await registerPasskey(user);
				const survivor = b64url(randomBytes(32));
				await storeChallenge({
					purpose: "passkey_first_registration",
					challenge: survivor,
					userId: user.id,
				});
				expect(
					(
						await verifyPasskeyRegistration(
							user.id,
							JSON.stringify(
								new SoftwareAuthenticator(user.id).register(survivor),
							),
							{ allowFirstPasskey: true },
						)
					).status,
				).toBe("invalid");
				expect(await listPasskeys(user.id)).toHaveLength(1);
			});

			it("a passkey sign-in can't reopen the no-code route after its passkey is removed", async () => {
				const {
					completePasskeyRegistration,
					getPasskeyRegistrationOptionsAfterSignIn,
				} = await actions();
				const { shouldOfferPasskey } = await import("@/lib/passkey-prompt");
				const user = await makeUser();
				fixture.currentUser = user;
				const now = Math.floor(Date.now() / 1000);
				fixture.session = {
					user: { id: user.id },
					authMethod: "email",
					authTime: now - 30,
				};
				const first = await getPasskeyRegistrationOptionsAfterSignIn();
				if (first.status !== "ok") throw new Error("No options.");
				const attacker = new SoftwareAuthenticator(user.id);
				expect(
					(
						await completePasskeyRegistration(
							JSON.stringify(attacker.register(first.options.challenge)),
						)
					).status,
				).toBe("registered");
				expect(
					(await verifyPasskeySignIn(attacker.assert(await signInChallenge())))
						?.id,
				).toBe(user.id);
				await database()
					.delete(userPasskeys)
					.where(eq(userPasskeys.userId, user.id));
				const leftover = await getPasskeyRegistrationOptionsAfterSignIn();
				if (leftover.status !== "ok") throw new Error("No options.");

				fixture.session = {
					user: { id: user.id },
					authMethod: "passkey",
					authTime: now - 30,
				};
				expect(await shouldOfferPasskey(user)).toBe(false);
				expect(await getPasskeyRegistrationOptionsAfterSignIn()).toEqual({
					status: "verify",
				});
				expect(
					(
						await completePasskeyRegistration(
							JSON.stringify(
								new SoftwareAuthenticator(user.id).register(
									leftover.options.challenge,
								),
							),
						)
					).status,
				).not.toBe("registered");

				fixture.session = { user: { id: user.id }, authTime: now - 30 };
				expect(await shouldOfferPasskey(user)).toBe(false);
				expect(await getPasskeyRegistrationOptionsAfterSignIn()).toEqual({
					status: "verify",
				});
				expect(await listPasskeys(user.id)).toHaveLength(0);
			});

			it("signing out of all devices also revokes connected MCP apps", async () => {
				const { signOutAllDevices } = await import(
					"@/app/(org)/dashboard/settings/account/server"
				);
				const user = await makeUser();
				const tokenId = id();
				await database()
					.insert(mcpOAuthTokens)
					.values({
						id: tokenId,
						userId: user.id,
						clientId: "client",
						familyId: id(),
						resource: "https://cap.test/mcp",
						accessHash: randomUUID().replaceAll("-", ""),
						refreshHash: randomUUID().replaceAll("-", ""),
						accessExpiresAt: new Date(Date.now() + 3_600_000),
						refreshExpiresAt: new Date(Date.now() + 86_400_000),
					});
				fixture.currentUser = user;
				await signOutAllDevices();
				const [token] = await database()
					.select()
					.from(mcpOAuthTokens)
					.where(eq(mcpOAuthTokens.id, tokenId));
				expect(token?.revokedAt).toBeInstanceOf(Date);
				await database()
					.delete(mcpOAuthTokens)
					.where(eq(mcpOAuthTokens.id, tokenId));
			});

			describe("MCP authorization codes and sign-out", () => {
				const redirectUri = "https://client.test/callback";
				const resource = "https://cap.test/api/mcp";
				const clients: string[] = [];

				async function issueCode(
					user: Pick<
						Awaited<ReturnType<typeof makeUser>>,
						"id" | "authSessionVersion"
					>,
				) {
					const { createMcpAuthorizationCode } = await import("@/lib/mcp-auth");
					const clientId = `cap_mcp_client_${id()}`;
					clients.push(clientId);
					await database()
						.insert(mcpOAuthClients)
						.values({
							id: id(),
							clientId,
							clientName: "Test client",
							redirectUris: [redirectUri],
						});
					const verifier = nodeCrypto.randomBytes(32).toString("base64url");
					const code = await createMcpAuthorizationCode(user, {
						clientId,
						redirectUri,
						codeChallenge: nodeCrypto
							.createHash("sha256")
							.update(verifier)
							.digest("base64url"),
						state: null,
						resource,
					});
					return new URLSearchParams({
						grant_type: "authorization_code",
						code,
						client_id: clientId,
						redirect_uri: redirectUri,
						code_verifier: verifier,
						resource,
					});
				}

				async function liveTokens(userId: User.UserId) {
					const rows = await database()
						.select({ revokedAt: mcpOAuthTokens.revokedAt })
						.from(mcpOAuthTokens)
						.where(eq(mcpOAuthTokens.userId, userId));
					return rows.filter((row) => row.revokedAt === null).length;
				}

				afterAll(async () => {
					if (createdUsers.length > 0) {
						await database()
							.delete(mcpOAuthTokens)
							.where(inArray(mcpOAuthTokens.userId, createdUsers));
						await database()
							.delete(mcpOAuthCodes)
							.where(inArray(mcpOAuthCodes.userId, createdUsers));
					}
					if (clients.length > 0)
						await database()
							.delete(mcpOAuthClients)
							.where(inArray(mcpOAuthClients.clientId, clients));
				});

				it("a pending code can't be exchanged after signing out of all devices", async () => {
					const { signOutAllDevices } = await import(
						"@/app/(org)/dashboard/settings/account/server"
					);
					const { exchangeMcpCode } = await import("@/lib/mcp-auth");
					const user = await makeUser();
					const params = await issueCode(user);
					fixture.currentUser = user;
					await signOutAllDevices();
					expect(await exchangeMcpCode(params)).toBeNull();
					expect(await liveTokens(user.id)).toBe(0);
				});

				it("signing out of all devices voids pending CLI login codes", async () => {
					const { signOutAllDevices } = await import(
						"@/app/(org)/dashboard/settings/account/server"
					);
					const user = await makeUser();
					const codeId = id();
					await database()
						.insert(agentApiAuthorizationCodes)
						.values({
							id: codeId,
							userId: user.id,
							codeHash: randomUUID().replaceAll("-", ""),
							codeChallenge: "c".repeat(43),
							redirectUri: "http://127.0.0.1:53682/callback",
							scopes: ["caps:read"],
							expiresAt: new Date(Date.now() + 5 * 60_000),
						});
					fixture.currentUser = user;
					await signOutAllDevices();
					const [code] = await database()
						.select({ consumedAt: agentApiAuthorizationCodes.consumedAt })
						.from(agentApiAuthorizationCodes)
						.where(eq(agentApiAuthorizationCodes.id, codeId));
					expect(code?.consumedAt).toBeInstanceOf(Date);
					await database()
						.delete(agentApiAuthorizationCodes)
						.where(eq(agentApiAuthorizationCodes.id, codeId));
				});

				it("a code can't be issued from a session that was signed out", async () => {
					const { signOutAllDevices } = await import(
						"@/app/(org)/dashboard/settings/account/server"
					);
					const user = await makeUser();
					fixture.currentUser = user;
					await signOutAllDevices();
					await expect(issueCode(user)).rejects.toThrow("Session expired");
					const codes = await database()
						.select({ id: mcpOAuthCodes.id })
						.from(mcpOAuthCodes)
						.where(eq(mcpOAuthCodes.userId, user.id));
					expect(codes).toHaveLength(0);
				});

				it("a token from before sign-out can't be refreshed", async () => {
					const { signOutAllDevices } = await import(
						"@/app/(org)/dashboard/settings/account/server"
					);
					const { exchangeMcpCode, refreshMcpTokens } = await import(
						"@/lib/mcp-auth"
					);
					const user = await makeUser();
					const params = await issueCode(user);
					const tokens = await exchangeMcpCode(params);
					expect(tokens?.refresh_token).toBeTruthy();
					fixture.currentUser = user;
					await signOutAllDevices();
					expect(
						await refreshMcpTokens(
							new URLSearchParams({
								grant_type: "refresh_token",
								refresh_token: tokens?.refresh_token ?? "",
								client_id: params.get("client_id") ?? "",
								resource,
							}),
						),
					).toBeNull();
					expect(await liveTokens(user.id)).toBe(0);
				});

				it("an exchange or refresh racing sign-out never leaves a live token", async () => {
					const { signOutAllDevices } = await import(
						"@/app/(org)/dashboard/settings/account/server"
					);
					const { exchangeMcpCode, refreshMcpTokens } = await import(
						"@/lib/mcp-auth"
					);
					for (let round = 0; round < 6; round++) {
						const user = await makeUser();
						const params = await issueCode(user);
						const pending = await issueCode(user);
						const tokens = await exchangeMcpCode(params);
						fixture.currentUser = user;
						await Promise.all([
							exchangeMcpCode(pending),
							refreshMcpTokens(
								new URLSearchParams({
									grant_type: "refresh_token",
									refresh_token: tokens?.refresh_token ?? "",
									client_id: params.get("client_id") ?? "",
									resource,
								}),
							),
							signOutAllDevices(),
						]);
						expect(await liveTokens(user.id)).toBe(0);
					}
				});
			});

			it("signing out of all devices removes passkeys and pending checks", async () => {
				const { signOutAllDevices } = await import(
					"@/app/(org)/dashboard/settings/account/server"
				);
				const user = await makeUser();
				const authenticator = await registerPasskey(user);
				await issueStepUpGrant(user.id);
				fixture.currentUser = user;
				await signOutAllDevices();
				expect(await listPasskeys(user.id)).toHaveLength(0);
				expect(
					await database()
						.select()
						.from(authChallenges)
						.where(eq(authChallenges.userId, user.id)),
				).toHaveLength(0);
				expect(
					await verifyPasskeySignIn(
						authenticator.assert(await signInChallenge()),
					),
				).toBeNull();
			});

			it("does not add a passkey started before signing out of all devices", async () => {
				const { signOutAllDevices } = await import(
					"@/app/(org)/dashboard/settings/account/server"
				);
				const user = await makeUser();
				const options = await createPasskeyRegistrationOptions(user);
				if (!options) throw new Error("Missing options.");
				fixture.currentUser = user;
				await signOutAllDevices();
				const response = JSON.stringify(
					new SoftwareAuthenticator(user.id).register(options.challenge),
				);
				expect(
					(await verifyPasskeyRegistration(user.id, response)).status,
				).toBe("invalid");
				expect(await listPasskeys(user.id)).toHaveLength(0);

				const fresh = await reloadUser(user.id);
				const retry = await createPasskeyRegistrationOptions(fresh);
				if (!retry) throw new Error("Missing options.");
				fixture.afterRegistrationVerify = async () => {
					fixture.currentUser = fresh;
					await signOutAllDevices();
				};
				expect(
					(
						await verifyPasskeyRegistration(
							user.id,
							JSON.stringify(
								new SoftwareAuthenticator(user.id).register(retry.challenge),
							),
						)
					).status,
				).toBe("invalid");
				expect(await listPasskeys(user.id)).toHaveLength(0);
			});

			it("lets a fresh sign-in add a passkey from the prompt without a code", async () => {
				const {
					completePasskeyRegistration,
					getPasskeyRegistrationOptionsAfterSignIn,
				} = await actions();
				const user = await makeUser();
				const other = await makeUser();
				fixture.currentUser = user;
				const now = Math.floor(Date.now() / 1000);

				fixture.session = {
					user: { id: user.id },
					authMethod: "email",
					authTime: now - 11 * 60,
				};
				expect(await getPasskeyRegistrationOptionsAfterSignIn()).toEqual({
					status: "verify",
				});
				fixture.session = { user: { id: user.id } };
				expect(await getPasskeyRegistrationOptionsAfterSignIn()).toEqual({
					status: "verify",
				});
				fixture.session = {
					user: { id: user.id },
					authMethod: "email",
					authTime: now + 600,
				};
				expect(await getPasskeyRegistrationOptionsAfterSignIn()).toEqual({
					status: "verify",
				});
				fixture.session = {
					user: { id: other.id },
					authMethod: "email",
					authTime: now,
				};
				expect(await getPasskeyRegistrationOptionsAfterSignIn()).toEqual({
					status: "verify",
				});

				fixture.session = {
					user: { id: user.id },
					authMethod: "email",
					authTime: now - 60,
				};
				const options = await getPasskeyRegistrationOptionsAfterSignIn();
				if (options.status !== "ok") throw new Error("No options.");
				const result = await completePasskeyRegistration(
					JSON.stringify(
						new SoftwareAuthenticator(user.id).register(
							options.options.challenge,
						),
					),
				);
				expect(result.status).toBe("registered");
				expect(await listPasskeys(user.id)).toHaveLength(1);
			});

			it("lets a fresh sign-in add only the account's first passkey", async () => {
				const {
					completePasskeyRegistration,
					getPasskeyRegistrationOptionsAfterSignIn,
				} = await actions();
				const now = Math.floor(Date.now() / 1000);

				const owner = await makeUser();
				await registerPasskey(owner);
				fixture.currentUser = owner;
				fixture.session = {
					user: { id: owner.id },
					authMethod: "email",
					authTime: now - 30,
				};
				expect(await getPasskeyRegistrationOptionsAfterSignIn()).toEqual({
					status: "verify",
				});
				expect(await listPasskeys(owner.id)).toHaveLength(1);

				const late = await makeUser();
				fixture.currentUser = late;
				fixture.session = {
					user: { id: late.id },
					authMethod: "email",
					authTime: now - 30,
				};
				const pending = await getPasskeyRegistrationOptionsAfterSignIn();
				if (pending.status !== "ok") throw new Error("No options.");
				await registerPasskey(late);
				expect(
					(
						await completePasskeyRegistration(
							JSON.stringify(
								new SoftwareAuthenticator(late.id).register(
									pending.options.challenge,
								),
							),
						)
					).status,
				).toBe("invalid");
				expect(await listPasskeys(late.id)).toHaveLength(1);

				const racing = await makeUser();
				fixture.currentUser = racing;
				fixture.session = {
					user: { id: racing.id },
					authMethod: "email",
					authTime: now - 30,
				};
				const challenges = [];
				for (let index = 0; index < 3; index++) {
					const options = await getPasskeyRegistrationOptionsAfterSignIn();
					if (options.status !== "ok") throw new Error("No options.");
					challenges.push(options.options.challenge);
				}
				const results = await Promise.all(
					challenges.map((challenge) =>
						verifyPasskeyRegistration(
							racing.id,
							JSON.stringify(
								new SoftwareAuthenticator(racing.id).register(challenge),
							),
							{ allowFirstPasskey: true },
						),
					),
				);
				expect(
					results.filter((result) => result.status === "registered"),
				).toHaveLength(1);
				expect(await listPasskeys(racing.id)).toHaveLength(1);
			});

			it("offers the prompt only after a fresh sign-in, without passkeys, unless snoozed", async () => {
				const { dismissPasskeyPrompt } = await actions();
				const { shouldOfferPasskey } = await import("@/lib/passkey-prompt");
				const user = await makeUser();
				const now = Math.floor(Date.now() / 1000);
				const fresh = {
					user: { id: user.id },
					authMethod: "email",
					authTime: now - 30,
				};

				fixture.session = fresh;
				expect(await shouldOfferPasskey(await reloadUser(user.id))).toBe(true);
				fixture.session = {
					user: { id: user.id },
					authMethod: "email",
					authTime: now - 11 * 60,
				};
				expect(await shouldOfferPasskey(await reloadUser(user.id))).toBe(false);
				fixture.session = null;
				expect(await shouldOfferPasskey(await reloadUser(user.id))).toBe(false);

				fixture.session = fresh;
				fixture.currentUser = user;
				await dismissPasskeyPrompt();
				const snoozed = await reloadUser(user.id);
				expect(typeof snoozed.preferences?.passkeyPromptDismissedAt).toBe(
					"string",
				);
				expect(await shouldOfferPasskey(snoozed)).toBe(false);
				const later = Date.now() + 31 * 24 * 60 * 60 * 1000;
				fixture.session = {
					user: { id: user.id },
					authMethod: "email",
					authTime: Math.floor(later / 1000) - 30,
				};
				expect(await shouldOfferPasskey(snoozed, later)).toBe(true);

				const withPasskey = await makeUser();
				await registerPasskey(withPasskey);
				fixture.session = {
					user: { id: withPasskey.id },
					authMethod: "email",
					authTime: now - 30,
				};
				expect(await shouldOfferPasskey(await reloadUser(withPasskey.id))).toBe(
					false,
				);
			});

			it("keeps other preferences when snoozing the prompt", async () => {
				const { dismissPasskeyPrompt } = await actions();
				const user = await makeUser();
				await database()
					.update(users)
					.set({ preferences: { dashboard: { pageSize: 30 } } as never })
					.where(eq(users.id, user.id));
				fixture.currentUser = user;
				await dismissPasskeyPrompt();
				const saved = await reloadUser(user.id);
				expect(saved.preferences?.dashboard?.pageSize).toBe(30);
				expect(typeof saved.preferences?.passkeyPromptDismissedAt).toBe(
					"string",
				);
			});

			it("rejects every action without a session", async () => {
				const passkeyActions = await actions();
				fixture.currentUser = null;
				for (const call of [
					() => passkeyActions.sendSecurityCode(),
					() => passkeyActions.verifySecurityCode("123456"),
					() => passkeyActions.getPasskeyStepUpOptions(),
					() => passkeyActions.verifyPasskeyForStepUp("{}"),
					() => passkeyActions.getPasskeyRegistrationOptions("x"),
					() => passkeyActions.completePasskeyRegistration("{}"),
					() => passkeyActions.listMyPasskeys(),
					() => passkeyActions.removePasskey("x", "y"),
				]) {
					await expect(call()).rejects.toThrow("Unauthorized");
				}
				expect((await passkeyActions.getPasskeySignInOptions()).status).toBe(
					"ok",
				);
			});
		});

		describe("confirming it's you", () => {
			it("accepts only the account's own passkey", async () => {
				const user = await makeUser();
				const other = await makeUser();
				const authenticator = await registerPasskey(user);
				expect(await createPasskeyStepUpOptions(other.id)).toBeNull();

				const otherWithKey = await makeUser();
				await registerPasskey(otherWithKey);
				const otherOptions = await createPasskeyStepUpOptions(otherWithKey.id);
				if (!otherOptions) throw new Error("Missing options.");
				expect(
					await verifyPasskeyStepUp(
						otherWithKey.id,
						authenticator.assert(otherOptions.challenge),
					),
				).toBe(false);

				const options = await createPasskeyStepUpOptions(user.id);
				if (!options) throw new Error("Missing options.");
				expect(options.allowCredentials?.map((entry) => entry.id)).toEqual([
					authenticator.credentialId,
				]);
				expect(
					await verifyPasskeyStepUp(
						user.id,
						authenticator.assert(options.challenge),
					),
				).toBe(true);
			});

			it("refuses a sign-in challenge as a check", async () => {
				const user = await makeUser();
				const authenticator = await registerPasskey(user);
				expect(
					await verifyPasskeyStepUp(
						user.id,
						authenticator.assert(await signInChallenge()),
					),
				).toBe(false);
			});

			it("accepts an emailed code once, for its own account only", async () => {
				const user = await makeUser();
				const other = await makeUser();
				const issued = await issueStepUpCode(user.id);
				if (issued.status !== "issued") throw new Error("No code.");
				expect(await verifyStepUpCode(other.id, issued.code)).toBe(false);
				expect(await verifyStepUpCode(user.id, issued.code)).toBe(true);
				expect(await verifyStepUpCode(user.id, issued.code)).toBe(false);
			});

			it("stores only a keyed hash of the code", async () => {
				const user = await makeUser();
				const issued = await issueStepUpCode(user.id);
				if (issued.status !== "issued") throw new Error("No code.");
				const [row] = await database()
					.select()
					.from(authChallenges)
					.where(eq(authChallenges.userId, user.id));
				expect(row?.secretHash).toMatch(/^[0-9a-f]{64}$/);
				expect(row?.secretHash).not.toContain(issued.code);
				expect(row?.secretHash).not.toBe(
					createHash("sha256").update(issued.code).digest("hex"),
				);
			});

			it("accepts a correct code once when submissions race", async () => {
				const user = await makeUser();
				const issued = await issueStepUpCode(user.id);
				if (issued.status !== "issued") throw new Error("No code.");
				const results = await Promise.all(
					Array.from({ length: 5 }, () =>
						verifyStepUpCode(user.id, issued.code),
					),
				);
				expect(results.filter(Boolean)).toHaveLength(1);
			});

			it("compares at most five guesses, even when they race", async () => {
				const user = await makeUser();
				const issued = await issueStepUpCode(user.id);
				if (issued.status !== "issued") throw new Error("No code.");
				const wrong = issued.code === "000000" ? "111111" : "000000";
				const compare = vi.spyOn(nodeCrypto, "timingSafeEqual");
				let guesses: boolean[];
				try {
					guesses = await Promise.all(
						Array.from({ length: 25 }, () => verifyStepUpCode(user.id, wrong)),
					);
					expect(compare.mock.calls.length).toBeLessThanOrEqual(
						STEP_UP_CODE_MAX_ATTEMPTS,
					);
				} finally {
					compare.mockRestore();
				}
				expect(guesses.every((result) => result === false)).toBe(true);
				const [row] = await database()
					.select({ attempts: authChallenges.attempts })
					.from(authChallenges)
					.where(
						and(
							eq(authChallenges.userId, user.id),
							eq(authChallenges.purpose, "step_up_email_code"),
						),
					);
				expect(row?.attempts ?? STEP_UP_CODE_MAX_ATTEMPTS).toBeLessThanOrEqual(
					STEP_UP_CODE_MAX_ATTEMPTS,
				);
				expect(await verifyStepUpCode(user.id, issued.code)).toBe(false);
			});

			it("issues codes for many accounts at once without deadlocking", async () => {
				const accounts = await Promise.all(
					Array.from({ length: 12 }, () => makeUser()),
				);
				for (let round = 0; round < 3; round++) {
					if (round > 0) {
						await database()
							.update(authChallenges)
							.set({ expiresAt: new Date(Date.now() + 9 * 60 * 1000) })
							.where(
								inArray(
									authChallenges.userId,
									accounts.map((account) => account.id),
								),
							);
					}
					const results = await Promise.all(
						accounts.map((account) => issueStepUpCode(account.id)),
					);
					expect(results.every((result) => result.status === "issued")).toBe(
						true,
					);
				}
			});

			it("issues one code when requests race", async () => {
				const user = await makeUser();
				const results = await Promise.all(
					Array.from({ length: 6 }, () => issueStepUpCode(user.id)),
				);
				expect(
					results.filter((result) => result.status === "issued"),
				).toHaveLength(1);
				const rows = await database()
					.select()
					.from(authChallenges)
					.where(
						and(
							eq(authChallenges.userId, user.id),
							eq(authChallenges.purpose, "step_up_email_code"),
						),
					);
				expect(rows).toHaveLength(1);
			});

			it("sends at most ten codes a day to one account", async () => {
				const user = await makeUser();
				let lastCode = "";
				for (let sent = 0; sent < STEP_UP_CODES_PER_DAY; sent++) {
					const issued = await issueStepUpCode(user.id);
					expect(issued.status).toBe("issued");
					if (issued.status === "issued") lastCode = issued.code;
					await database()
						.update(authChallenges)
						.set({ expiresAt: new Date(Date.now() + 9 * 60 * 1000) })
						.where(
							and(
								eq(authChallenges.userId, user.id),
								eq(authChallenges.purpose, "step_up_email_code"),
							),
						);
				}
				expect((await issueStepUpCode(user.id)).status).toBe("daily_limit");
				expect(await verifyStepUpCode(user.id, lastCode)).toBe(true);
				const other = await makeUser();
				expect((await issueStepUpCode(other.id)).status).toBe("issued");
			});

			it("refuses an expired code and rate limits new codes", async () => {
				const user = await makeUser();
				const issued = await issueStepUpCode(user.id);
				if (issued.status !== "issued") throw new Error("No code.");
				expect((await issueStepUpCode(user.id)).status).toBe("cooldown");
				await database()
					.update(authChallenges)
					.set({ expiresAt: new Date(Date.now() - 1000) })
					.where(eq(authChallenges.userId, user.id));
				expect(await verifyStepUpCode(user.id, issued.code)).toBe(false);
			});

			it("rejects codes that are not six digits", async () => {
				const user = await makeUser();
				for (const code of ["", "12345", "1234567", "12345a", " 1 2 3"]) {
					expect(await verifyStepUpCode(user.id, code)).toBe(false);
				}
			});

			it("binds the confirmation to its account and expires it", async () => {
				const user = await makeUser();
				const other = await makeUser();
				const grant = await issueStepUpGrant(user.id);
				expect(await hasStepUpGrant(user.id, grant)).toBe(true);
				expect(await hasStepUpGrant(other.id, grant)).toBe(false);
				expect(
					await hasStepUpGrant(
						user.id,
						`${grant.slice(0, -1)}${grant.endsWith("A") ? "B" : "A"}`,
					),
				).toBe(false);
				expect(await hasStepUpGrant(user.id, "short")).toBe(false);
				expect(await hasStepUpGrant(user.id, null)).toBe(false);
				await database()
					.update(authChallenges)
					.set({ expiresAt: new Date(Date.now() - 1000) })
					.where(eq(authChallenges.userId, user.id));
				expect(await hasStepUpGrant(user.id, grant)).toBe(false);
			});
		});
	},
);
