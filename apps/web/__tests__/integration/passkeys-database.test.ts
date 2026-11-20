import {
	createHash,
	generateKeyPairSync,
	type KeyObject,
	randomBytes,
	randomUUID,
	sign,
} from "node:crypto";
import { authChallenges, userPasskeys, users } from "@cap/database/schema";
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

function clientData(type: string, challenge: string, origin: string) {
	return Buffer.from(
		JSON.stringify({ type, challenge, origin, crossOrigin: false }),
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
		options: { origin?: string; rpId?: string; flags?: number } = {},
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
			new Map<string, string | Uint8Array | Map<string, never>>([
				["fmt", "none"],
				["attStmt", new Map()],
				["authData", authData],
			]),
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
				const pending = [];
				for (let index = 0; index < MAX_PASSKEYS_PER_USER + 2; index++) {
					const options = await createPasskeyRegistrationOptions(user);
					if (!options) throw new Error("Missing options.");
					pending.push(
						JSON.stringify(
							new SoftwareAuthenticator(user.id).register(options.challenge),
						),
					);
				}
				const results = await Promise.all(
					pending.map((response) =>
						verifyPasskeyRegistration(user.id, response),
					),
				);
				expect(
					results.filter((result) => result.status === "registered"),
				).toHaveLength(MAX_PASSKEYS_PER_USER);
				expect(await listPasskeys(user.id)).toHaveLength(MAX_PASSKEYS_PER_USER);
				expect(await createPasskeyRegistrationOptions(user)).toBeNull();
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
							createHash("sha256").update(challenge).digest("hex"),
						),
					);
				expect(
					await verifyPasskeySignIn(authenticator.assert(challenge)),
				).toBeNull();
			});

			it("refuses challenges issued for registration or another user's check", async () => {
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
				expect(await deletePasskey(other.id, stored.id)).toBe(false);
				expect(await deletePasskey(user.id, stored.id)).toBe(true);
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

			it("burns the code after the attempt limit, even under concurrent guesses", async () => {
				const user = await makeUser();
				const issued = await issueStepUpCode(user.id);
				if (issued.status !== "issued") throw new Error("No code.");
				const wrong = issued.code === "000000" ? "111111" : "000000";
				const guesses = await Promise.all(
					Array.from({ length: 25 }, () => verifyStepUpCode(user.id, wrong)),
				);
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
