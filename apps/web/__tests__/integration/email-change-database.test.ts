import { randomUUID } from "node:crypto";
import {
	accounts,
	authChallenges,
	directoryUsers,
	emailChangeRequests,
	sessions,
	users,
} from "@cap/database/schema";
import { Organisation, User } from "@cap/web-domain";
import { eq, inArray } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { createPool, type Pool } from "mysql2/promise";
import { encode } from "next-auth/jwt";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { issueStepUpGrant } from "../../../../packages/database/auth/auth-challenges";
import { DrizzleAdapter } from "../../../../packages/database/auth/drizzle-adapter";

const SECRET = "email-change-database-test-secret-0123456789";

const fixture = vi.hoisted(() => ({
	database: undefined as MySql2Database | undefined,
	env: {} as Record<string, string | undefined>,
	isCap: "false",
	currentUser: null as unknown,
	codes: [] as { email: string; code: string }[],
	notices: [] as { previousEmail: string; newEmail: string }[],
	stripeUpdates: [] as { id: string; params: Record<string, unknown> }[],
	stripeFails: false,
}));

vi.mock("@cap/database", () => ({
	db: () => {
		if (!fixture.database) throw new Error("Test database is not connected.");
		return fixture.database;
	},
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => fixture.env,
	buildEnv: {
		get NEXT_PUBLIC_IS_CAP() {
			return fixture.isCap;
		},
	},
}));
vi.mock("@cap/utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/utils")>()),
	STRIPE_AVAILABLE: () => true,
	stripe: () => ({
		customers: {
			update: async (id: string, params: Record<string, unknown>) => {
				if (fixture.stripeFails) throw new Error("Stripe is down");
				fixture.stripeUpdates.push({ id, params });
				return { id };
			},
		},
	}),
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => fixture.currentUser,
}));
vi.mock("@cap/database/auth/security-emails", () => ({
	sendEmailChangeCode: async (email: string, code: string) => {
		fixture.codes.push({ email, code });
	},
	sendEmailChangedNotice: async (previousEmail: string, newEmail: string) => {
		fixture.notices.push({ previousEmail, newEmail });
	},
}));
vi.mock("@/lib/rate-limit", () => ({
	isRateLimited: async () => false,
	RATE_LIMIT_IDS: {
		AUTH_OTP_SEND: "rl_auth_otp_send",
		AUTH_OTP_VERIFY: "rl_auth_otp_verify",
	},
}));
vi.mock("@/lib/email-code-rate-limit", () => ({
	isEmailCodeSendLimited: async () => false,
}));

const databaseUrl = process.env.CAP_PASSKEYS_TEST_DATABASE_URL;
const createdUsers: User.UserId[] = [];

function database() {
	if (!fixture.database) throw new Error("Test database is not connected.");
	return fixture.database;
}

function id() {
	return randomUUID().replaceAll("-", "").slice(0, 15);
}

function address(prefix = "person") {
	return `${prefix}-${id()}@example.com`;
}

async function makeUser(
	email = address(),
	extra: Partial<typeof users.$inferInsert> = {},
) {
	const userId = User.UserId.make(id());
	await database()
		.insert(users)
		.values({
			id: userId,
			email,
			name: "Email change",
			activeOrganizationId: Organisation.OrganisationId.make(id()),
			...extra,
		});
	createdUsers.push(userId);
	const [row] = await database()
		.select()
		.from(users)
		.where(eq(users.id, userId));
	if (!row) throw new Error("User was not created.");
	return row;
}

async function reload(userId: User.UserId) {
	const [row] = await database()
		.select()
		.from(users)
		.where(eq(users.id, userId));
	return row;
}

async function actions() {
	return import("@/actions/auth/email-change");
}

async function start(
	user: Awaited<ReturnType<typeof makeUser>>,
	newEmail: string,
) {
	const { startEmailChange } = await actions();
	fixture.currentUser = user;
	const grant = await issueStepUpGrant(user.id);
	return startEmailChange(grant, newEmail);
}

function lastCode(email: string) {
	const entry = fixture.codes.filter((item) => item.email === email).at(-1);
	if (!entry) throw new Error(`No code sent to ${email}`);
	return entry.code;
}

async function allowResend(userId: User.UserId) {
	await database()
		.update(emailChangeRequests)
		.set({ expiresAt: new Date(Date.now() + 9 * 60 * 1000) })
		.where(eq(emailChangeRequests.userId, userId));
}

describe.runIf(Boolean(databaseUrl))(
	"Changing the account email with an isolated MySQL database",
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
					"Email change tests require a session-scoped local database.",
				);
			}
			pool = createPool({ uri: databaseUrl, connectionLimit: 10 });
			fixture.database = drizzle(pool) as unknown as MySql2Database;
		});

		beforeEach(() => {
			fixture.env = {
				WEB_URL: "https://cap.test",
				NEXTAUTH_SECRET: SECRET,
				CAP_BLOCKED_SIGNUP_DOMAINS: "blocked.test",
			};
			fixture.isCap = "false";
			fixture.stripeFails = false;
		});

		afterAll(async () => {
			if (fixture.database && createdUsers.length > 0) {
				await database()
					.delete(emailChangeRequests)
					.where(inArray(emailChangeRequests.userId, createdUsers));
				await database()
					.delete(accounts)
					.where(inArray(accounts.userId, createdUsers));
				await database()
					.delete(directoryUsers)
					.where(inArray(directoryUsers.userId, createdUsers));
				await database()
					.delete(sessions)
					.where(inArray(sessions.userId, createdUsers));
				await database().delete(users).where(inArray(users.id, createdUsers));
			}
			await pool?.end();
		});

		it("changes the email once the new address is confirmed", async () => {
			const user = await makeUser(address("Old"), {
				stripeCustomerId: `cus_${id()}`,
			});
			const newEmail = address("new");
			await database()
				.insert(sessions)
				.values({
					id: id(),
					sessionToken: id(),
					userId: user.id,
					expires: new Date(Date.now() + 86_400_000),
				});
			const started = await start(user, `  ${newEmail.toUpperCase()} `);
			expect(
				await database()
					.select()
					.from(authChallenges)
					.where(eq(authChallenges.userId, user.id)),
			).toHaveLength(1);
			expect(started).toEqual({ status: "sent", email: newEmail });
			expect(fixture.codes.at(-1)?.email).toBe(newEmail);
			expect((await reload(user.id))?.email).toBe(user.email);

			const { finishEmailChange } = await actions();
			expect(await finishEmailChange(lastCode(newEmail))).toEqual({
				status: "changed",
				email: newEmail,
			});
			const changed = await reload(user.id);
			expect(changed?.email).toBe(newEmail);
			expect(changed?.emailVerified).toBeInstanceOf(Date);
			expect(changed?.authSessionVersion).toBe(user.authSessionVersion + 1);
			expect(
				await database()
					.select()
					.from(sessions)
					.where(eq(sessions.userId, user.id)),
			).toHaveLength(0);
			expect(
				await database()
					.select()
					.from(emailChangeRequests)
					.where(eq(emailChangeRequests.userId, user.id)),
			).toHaveLength(0);
			expect(
				await database()
					.select()
					.from(authChallenges)
					.where(eq(authChallenges.userId, user.id)),
			).toHaveLength(0);
			expect(fixture.notices.at(-1)).toEqual({
				previousEmail: user.email,
				newEmail,
			});
			expect(fixture.stripeUpdates.at(-1)).toEqual({
				id: user.stripeCustomerId,
				params: { email: newEmail, metadata: { userId: user.id } },
			});

			const adapter = DrizzleAdapter(database());
			expect((await adapter.getUserByEmail?.(newEmail))?.id).toBe(user.id);
			expect(await adapter.getUserByEmail?.(user.email)).toBeNull();
		});

		it("signs out every existing session", async () => {
			const { decodeSessionToken } = await import(
				"../../../../packages/database/auth/auth-options"
			);
			const user = await makeUser();
			const token = await encode({
				token: {
					id: user.id,
					email: user.email,
					sessionVersion: user.authSessionVersion,
				},
				secret: SECRET,
			});
			expect((await decodeSessionToken({ token, secret: SECRET }))?.id).toBe(
				user.id,
			);
			const newEmail = address();
			await start(user, newEmail);
			const { finishEmailChange } = await actions();
			expect((await finishEmailChange(lastCode(newEmail))).status).toBe(
				"changed",
			);
			expect(await decodeSessionToken({ token, secret: SECRET })).toBeNull();
		});

		it("requires a fresh confirmation for this account before sending a code", async () => {
			const { startEmailChange } = await actions();
			const user = await makeUser();
			const other = await makeUser();
			fixture.currentUser = user;
			const sentBefore = fixture.codes.length;
			expect(await startEmailChange("", address())).toEqual({
				status: "verify",
			});
			expect(
				await startEmailChange(await issueStepUpGrant(other.id), address()),
			).toEqual({ status: "verify" });
			const grant = await issueStepUpGrant(user.id);
			await database()
				.update(authChallenges)
				.set({ expiresAt: new Date(Date.now() - 60_000) })
				.where(eq(authChallenges.userId, user.id));
			expect(await startEmailChange(grant, address())).toEqual({
				status: "verify",
			});
			expect(fixture.codes.length).toBe(sentBefore);
		});

		it("rejects every action without a session", async () => {
			const { finishEmailChange, startEmailChange } = await actions();
			fixture.currentUser = null;
			await expect(startEmailChange("x", address())).rejects.toThrow(
				"Unauthorized",
			);
			await expect(finishEmailChange("123456")).rejects.toThrow("Unauthorized");
		});

		it("binds the code to the account that asked for it", async () => {
			const { finishEmailChange } = await actions();
			const user = await makeUser();
			const other = await makeUser();
			const newEmail = address();
			await start(user, newEmail);
			const code = lastCode(newEmail);
			fixture.currentUser = other;
			expect(await finishEmailChange(code)).toEqual({ status: "invalid" });
			const otherEmail = address();
			await start(other, otherEmail);
			fixture.currentUser = other;
			const otherCode = lastCode(otherEmail);
			expect(
				await finishEmailChange(code === otherCode ? "000000" : code),
			).toEqual({ status: "invalid" });
			expect((await reload(other.id))?.email).toBe(other.email);
		});

		it("works once and only before it expires", async () => {
			const { finishEmailChange } = await actions();
			const user = await makeUser();
			const newEmail = address();
			await start(user, newEmail);
			const code = lastCode(newEmail);
			const results = await Promise.all([
				finishEmailChange(code),
				finishEmailChange(code),
				finishEmailChange(code),
			]);
			expect(
				results.filter((result) => result.status === "changed"),
			).toHaveLength(1);
			expect(await finishEmailChange(code)).toEqual({ status: "invalid" });

			const later = await makeUser();
			const laterEmail = address();
			await start(later, laterEmail);
			await database()
				.update(emailChangeRequests)
				.set({ expiresAt: new Date(Date.now() - 1000) })
				.where(eq(emailChangeRequests.userId, later.id));
			expect(await finishEmailChange(lastCode(laterEmail))).toEqual({
				status: "invalid",
			});
			expect((await reload(later.id))?.email).toBe(later.email);
		});

		it("burns the request after five wrong codes, even when guesses race", async () => {
			const { finishEmailChange } = await actions();
			const user = await makeUser();
			const newEmail = address();
			await start(user, newEmail);
			const code = lastCode(newEmail);
			const wrong = code === "000000" ? "111111" : "000000";
			const guesses = await Promise.all(
				Array.from({ length: 25 }, () => finishEmailChange(wrong)),
			);
			expect(guesses.every((guess) => guess.status === "invalid")).toBe(true);
			expect(await finishEmailChange(code)).toEqual({ status: "invalid" });
			expect((await reload(user.id))?.email).toBe(user.email);
		});

		it("replaces the old code when a new address is requested", async () => {
			const { finishEmailChange } = await actions();
			const user = await makeUser();
			const first = address("first");
			const second = address("second");
			await start(user, first);
			expect((await start(user, second)).status).toBe("cooldown");
			await allowResend(user.id);
			expect(await start(user, second)).toEqual({
				status: "sent",
				email: second,
			});
			expect(await finishEmailChange(lastCode(first))).toEqual({
				status: "invalid",
			});
			expect(await finishEmailChange(lastCode(second))).toMatchObject({
				status: "changed",
				email: second,
			});
		});

		it("issues one code when requests race", async () => {
			const user = await makeUser();
			fixture.currentUser = user;
			const { startEmailChange } = await actions();
			const grant = await issueStepUpGrant(user.id);
			const results = await Promise.all(
				Array.from({ length: 6 }, () => startEmailChange(grant, address())),
			);
			expect(results.filter((result) => result.status === "sent")).toHaveLength(
				1,
			);
			expect(
				await database()
					.select()
					.from(emailChangeRequests)
					.where(eq(emailChangeRequests.userId, user.id)),
			).toHaveLength(1);
		});

		it("does not reveal at request time that an address is taken", async () => {
			const { finishEmailChange } = await actions();
			const owner = await makeUser(address("Taken").replace("taken", "TaKen"));
			const user = await makeUser();
			const requested = owner.email.toLowerCase();
			expect(await start(user, requested)).toEqual({
				status: "sent",
				email: requested,
			});
			expect(await finishEmailChange(lastCode(requested))).toEqual({
				status: "taken",
			});
			expect((await reload(user.id))?.email).toBe(user.email);
			expect((await reload(owner.id))?.email).toBe(owner.email);
		});

		it("lets only one account claim an address when two race for it", async () => {
			const { finishEmailChange } = await actions();
			const first = await makeUser();
			const second = await makeUser();
			const contested = address("contested");
			await start(first, contested);
			const firstCode = lastCode(contested);
			await start(second, contested);
			const secondCode = lastCode(contested);
			const [firstResult, secondResult] = await Promise.all([
				(async () => {
					fixture.currentUser = first;
					return finishEmailChange(firstCode);
				})(),
				(async () => {
					fixture.currentUser = second;
					return finishEmailChange(secondCode);
				})(),
			]);
			const statuses = [firstResult.status, secondResult.status].sort();
			expect(statuses).toEqual(["changed", "taken"]);
			const owners = await database()
				.select({ id: users.id })
				.from(users)
				.where(eq(users.email, contested));
			expect(owners).toHaveLength(1);
		});

		it.each([
			["", "invalid"],
			["no-at-sign", "invalid"],
			["a@localhost", "invalid"],
			["two@at@example.com", "invalid"],
			['"quoted"@example.com', "invalid"],
			["pérson@example.com", "invalid"],
			[`${"x".repeat(250)}@example.com`, "invalid"],
			["someone@blocked.test", "not_allowed"],
		])("refuses %j as a new address", async (raw, status) => {
			const user = await makeUser();
			const sent = fixture.codes.length;
			expect(await start(user, raw)).toEqual({ status });
			expect(fixture.codes.length).toBe(sent);
		});

		it("refuses the current address in any letter case", async () => {
			const user = await makeUser();
			expect(await start(user, user.email.toUpperCase())).toEqual({
				status: "same",
			});
		});

		it("applies the signup allowlist and the disposable filter", async () => {
			const user = await makeUser();
			fixture.env.CAP_ALLOWED_SIGNUP_DOMAINS = "allowed.test";
			expect(await start(user, "someone@example.com")).toEqual({
				status: "not_allowed",
			});
			expect((await start(user, `p-${id()}@allowed.test`)).status).toBe("sent");
			fixture.env.CAP_ALLOWED_SIGNUP_DOMAINS = undefined;
			fixture.isCap = "true";
			const other = await makeUser();
			expect(await start(other, `p-${id()}@mailinator.com`)).toEqual({
				status: "not_allowed",
			});
		});

		it("re-checks the address when the change is confirmed", async () => {
			const { finishEmailChange } = await actions();
			const user = await makeUser();
			const newEmail = `p-${id()}@later-blocked.test`;
			await start(user, newEmail);
			fixture.env.CAP_BLOCKED_SIGNUP_DOMAINS =
				"blocked.test,later-blocked.test";
			expect(await finishEmailChange(lastCode(newEmail))).toEqual({
				status: "not_allowed",
			});
			expect((await reload(user.id))?.email).toBe(user.email);
		});

		it("leaves addresses owned by single sign-on or a directory alone", async () => {
			const { finishEmailChange } = await actions();
			const sso = await makeUser();
			await database()
				.insert(accounts)
				.values({
					id: id(),
					userId: sso.id,
					type: "oauth",
					provider: "workos",
					providerAccountId: `prof_${id()}`,
				});
			expect(await start(sso, address())).toEqual({ status: "managed" });

			const directory = await makeUser();
			await database()
				.insert(directoryUsers)
				.values({
					id: `directory_user_${id()}`,
					organizationId: Organisation.OrganisationId.make(id()),
					directoryId: `directory_${id()}`,
					userId: directory.id,
					email: directory.email,
				});
			expect(await start(directory, address())).toEqual({ status: "managed" });

			const later = await makeUser();
			const newEmail = address();
			await start(later, newEmail);
			await database()
				.insert(accounts)
				.values({
					id: id(),
					userId: later.id,
					type: "oauth",
					provider: "workos",
					providerAccountId: `prof_${id()}`,
				});
			fixture.currentUser = later;
			expect(await finishEmailChange(lastCode(newEmail))).toEqual({
				status: "managed",
			});
			expect((await reload(later.id))?.email).toBe(later.email);
		});

		it("keeps the old email when billing cannot be updated, and recovers", async () => {
			const { finishEmailChange } = await actions();
			const user = await makeUser(address(), {
				stripeCustomerId: `cus_${id()}`,
			});
			const newEmail = address();
			await start(user, newEmail);
			const code = lastCode(newEmail);
			fixture.stripeFails = true;
			expect(await finishEmailChange(code)).toEqual({ status: "failed" });
			expect((await reload(user.id))?.email).toBe(user.email);
			fixture.stripeFails = false;
			expect(await finishEmailChange(code)).toMatchObject({
				status: "changed",
			});
			expect((await reload(user.id))?.email).toBe(newEmail);
		});
	},
);
