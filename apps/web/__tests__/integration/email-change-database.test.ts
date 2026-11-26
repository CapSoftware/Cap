import { randomUUID } from "node:crypto";
import {
	accounts,
	authChallenges,
	directoryUsers,
	emailChangeRequests,
	organizationInvites,
	organizationMembers,
	organizations,
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
	stripeUpdates: [] as {
		id: string;
		params: Record<string, unknown>;
		options: unknown;
	}[],
	stripeFails: false as false | "down" | "missing",
	failLoops: false,
	stripeCustomers: new Map<
		string,
		{ email: string; metadata: Record<string, string> }
	>(),
	onStripeUpdate: null as null | (() => Promise<void>),
	workosDown: false,
	workosDomains: new Map<string, { domain: string; state: string }[]>(),
	limitedAddress: null as string | null,
	sendLimitedAddress: null as string | null,
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
			update: async (
				id: string,
				params: Record<string, unknown>,
				options?: unknown,
			) => {
				if (fixture.stripeFails === "missing") {
					throw Object.assign(new Error("No such customer"), {
						code: "resource_missing",
					});
				}
				if (fixture.stripeFails) throw new Error("Stripe is down");
				fixture.stripeUpdates.push({ id, params, options });
				const stored = fixture.stripeCustomers.get(id);
				if (stored) {
					if (typeof params.email === "string") stored.email = params.email;
					if (params.metadata && typeof params.metadata === "object") {
						stored.metadata = {
							...stored.metadata,
							...(params.metadata as Record<string, string>),
						};
					}
				}
				const hook = fixture.onStripeUpdate;
				fixture.onStripeUpdate = null;
				await hook?.();
				return { id, metadata: stored?.metadata ?? {} };
			},
			list: async ({ email }: { email: string }) => ({
				data: [...fixture.stripeCustomers.entries()]
					.filter(([, customer]) => customer.email === email)
					.map(([id, customer]) => ({ id, metadata: customer.metadata })),
			}),
			create: async (params: {
				email: string;
				metadata: Record<string, string>;
			}) => {
				const id = `cus_new_${fixture.stripeCustomers.size}_${Date.now()}`;
				fixture.stripeCustomers.set(id, {
					email: params.email,
					metadata: params.metadata,
				});
				return { id, metadata: params.metadata };
			},
		},
		subscriptions: { list: async () => ({ data: [] }) },
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
	isEmailCodeSendLimited: async () => {
		throw new Error("Email changes must not use the sign-in send bucket");
	},
	isEmailChangeSendLimited: async (email: string) =>
		email === fixture.sendLimitedAddress,
	isEmailCodeVerifyLimited: async () => {
		throw new Error("Email changes must not use the sign-in guess bucket");
	},
	isEmailChangeVerifyLimited: async (email: string) =>
		email === fixture.limitedAddress,
}));
vi.mock("../../../../packages/database/auth/sso", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../packages/database/auth/sso")
	>()),
	getWorkOS: () => ({
		organizations: {
			getOrganization: async (id: string) => {
				if (fixture.workosDown) throw new Error("WorkOS is down");
				return { id, domains: fixture.workosDomains.get(id) ?? [] };
			},
		},
	}),
}));
vi.mock("@cap/database/loops/queue", () => ({
	enqueueLoopsSync: async () => {
		if (fixture.failLoops) throw new Error("Loops queue is down");
	},
}));

const databaseUrl = process.env.CAP_PASSKEYS_TEST_DATABASE_URL;
const createdUsers: User.UserId[] = [];
const createdOrganizations: Organisation.OrganisationId[] = [];
const createdInvites: string[] = [];

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
			fixture.failLoops = false;
			fixture.limitedAddress = null;
			fixture.sendLimitedAddress = null;
			fixture.workosDown = false;
			fixture.onStripeUpdate = null;
		});

		afterAll(async () => {
			if (fixture.database && createdInvites.length > 0) {
				await database()
					.delete(organizationInvites)
					.where(inArray(organizationInvites.id, createdInvites));
			}
			if (fixture.database && createdOrganizations.length > 0) {
				await database()
					.delete(organizationMembers)
					.where(
						inArray(organizationMembers.organizationId, createdOrganizations),
					);
				await database()
					.delete(organizations)
					.where(inArray(organizations.id, createdOrganizations));
			}
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
				options: undefined,
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
			const otherEmail = address();
			await start(other, otherEmail);
			fixture.currentUser = other;
			const otherCode = lastCode(otherEmail);
			expect(
				await finishEmailChange(code === otherCode ? "000000" : code),
			).toEqual({ status: "invalid" });
			expect((await reload(other.id))?.email).toBe(other.email);
			fixture.currentUser = user;
			expect(await finishEmailChange(code)).toMatchObject({
				status: "changed",
				email: newEmail,
			});
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

		it("burns the request on a wrong code, like sign-in codes", async () => {
			const { finishEmailChange } = await actions();
			const user = await makeUser();
			const newEmail = address();
			await start(user, newEmail);
			const code = lastCode(newEmail);
			const wrong = code === "000000" ? "111111" : "000000";
			expect(await finishEmailChange(wrong)).toEqual({ status: "invalid" });
			expect(await finishEmailChange(code)).toEqual({ status: "invalid" });
			expect((await reload(user.id))?.email).toBe(user.email);
		});

		it("limits codes sent to one target address", async () => {
			const user = await makeUser();
			const target = address();
			fixture.sendLimitedAddress = target;
			const sent = fixture.codes.length;
			expect(await start(user, target)).toEqual({ status: "rate_limited" });
			expect(fixture.codes).toHaveLength(sent);
		});

		it("limits guesses per target address across accounts", async () => {
			const { finishEmailChange } = await actions();
			const user = await makeUser();
			const newEmail = address();
			await start(user, newEmail);
			fixture.limitedAddress = newEmail;
			expect(await finishEmailChange(lastCode(newEmail))).toEqual({
				status: "rate_limited",
			});
			fixture.limitedAddress = null;
			expect(await finishEmailChange(lastCode(newEmail))).toMatchObject({
				status: "changed",
			});
		});

		it("burns the request even when wrong guesses race", async () => {
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
			expect(
				await database()
					.select()
					.from(emailChangeRequests)
					.where(eq(emailChangeRequests.userId, user.id)),
			).toHaveLength(1);
			const [pending] = await database()
				.select({ newEmail: emailChangeRequests.newEmail })
				.from(emailChangeRequests)
				.where(eq(emailChangeRequests.userId, user.id));
			expect(pending?.newEmail).toBe(second);
			expect(await finishEmailChange(lastCode(second))).toMatchObject({
				status: "changed",
				email: second,
			});
			expect(await finishEmailChange(lastCode(first))).toEqual({
				status: "invalid",
			});
		});

		it("starts changes for many accounts at once without deadlocking", async () => {
			const { requestEmailChange } = await import(
				"../../../../packages/database/auth/email-change"
			);
			const people = await Promise.all(
				Array.from({ length: 12 }, () => makeUser()),
			);
			for (let round = 0; round < 3; round++) {
				if (round > 0) {
					await database()
						.update(emailChangeRequests)
						.set({ expiresAt: new Date(Date.now() + 9 * 60 * 1000) })
						.where(
							inArray(
								emailChangeRequests.userId,
								people.map((person) => person.id),
							),
						);
				}
				const results = await Promise.all(
					people.map((person) => requestEmailChange(person, address())),
				);
				expect(results.every((result) => result.status === "issued")).toBe(
					true,
				);
			}
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
			const owner = await makeUser(address("TaKen"));
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

		it("updates billing every time, even when an address is reused", async () => {
			const { finishEmailChange } = await actions();
			const user = await makeUser(address("a"), {
				stripeCustomerId: `cus_${id()}`,
			});
			const original = user.email;
			const other = address("b");
			const sequence = [other, original, other];
			let current = user;
			for (const target of sequence) {
				await start(current, target);
				expect(await finishEmailChange(lastCode(target))).toMatchObject({
					status: "changed",
				});
				const next = await reload(user.id);
				if (!next) throw new Error("User disappeared.");
				current = next;
			}
			const updates = fixture.stripeUpdates.filter(
				(update) => update.id === user.stripeCustomerId,
			);
			expect(updates.map((update) => update.params.email)).toEqual(sequence);
			expect(updates.every((update) => update.options === undefined)).toBe(
				true,
			);
		});

		it("leaves billing on the new address when a second confirm races the first", async () => {
			const { finishEmailChange } = await actions();
			const user = await makeUser(address(), {
				stripeCustomerId: `cus_${id()}`,
			});
			const newEmail = address();
			await start(user, newEmail);
			const code = lastCode(newEmail);
			await database()
				.update(emailChangeRequests)
				.set({ attempts: -5 })
				.where(eq(emailChangeRequests.userId, user.id));
			const results = await Promise.all([
				finishEmailChange(code),
				finishEmailChange(code),
				finishEmailChange(code),
			]);
			expect(
				results.filter((result) => result.status === "changed"),
			).toHaveLength(1);
			expect((await reload(user.id))?.email).toBe(newEmail);
			const last = fixture.stripeUpdates
				.filter((update) => update.id === user.stripeCustomerId)
				.at(-1);
			expect(last?.params.email).toBe(newEmail);
		});

		it("never hands a billing customer to a sign-up racing the change", async () => {
			const { finishEmailChange } = await actions();
			const { provisionStripeCustomer } = await import(
				"../../../../packages/database/auth/stripe-customer"
			);
			const customerId = `cus_${id()}`;
			const user = await makeUser(address(), { stripeCustomerId: customerId });
			fixture.stripeCustomers.set(customerId, {
				email: user.email,
				metadata: { userId: user.id },
			});
			const newEmail = address();
			await start(user, newEmail);
			let racer: Awaited<ReturnType<typeof makeUser>> | undefined;
			fixture.onStripeUpdate = async () => {
				racer = await makeUser(newEmail);
				racer = await provisionStripeCustomer(database(), racer);
			};
			expect(await finishEmailChange(lastCode(newEmail))).toEqual({
				status: "taken",
			});
			expect(racer?.stripeCustomerId).toBeTruthy();
			expect(racer?.stripeCustomerId).not.toBe(customerId);
			expect(fixture.stripeCustomers.get(customerId)).toEqual({
				email: user.email,
				metadata: { userId: user.id },
			});
			expect((await reload(user.id))?.stripeCustomerId).toBe(customerId);
		});

		it("still adopts a customer with no owner or a deleted owner at sign-up", async () => {
			const { provisionStripeCustomer } = await import(
				"../../../../packages/database/auth/stripe-customer"
			);
			const owners: Record<string, string>[] = [{}, { userId: `gone_${id()}` }];
			for (const metadata of owners) {
				const email = address("guest");
				const customerId = `cus_${id()}`;
				fixture.stripeCustomers.set(customerId, { email, metadata });
				const signup = await provisionStripeCustomer(
					database(),
					await makeUser(email),
				);
				expect(signup.stripeCustomerId).toBe(customerId);
				expect(fixture.stripeCustomers.get(customerId)?.metadata.userId).toBe(
					signup.id,
				);
			}
		});

		it("refuses a change still in flight when the owner signs out of all devices", async () => {
			const { finishEmailChange } = await actions();
			const { signOutAllDevices } = await import(
				"@/app/(org)/dashboard/settings/account/server"
			);
			const user = await makeUser(address(), {
				stripeCustomerId: `cus_${id()}`,
			});
			const newEmail = address();
			await start(user, newEmail);
			fixture.onStripeUpdate = async () => {
				await database()
					.update(users)
					.set({ authSessionVersion: user.authSessionVersion + 1 })
					.where(eq(users.id, user.id));
			};
			expect(await finishEmailChange(lastCode(newEmail))).toEqual({
				status: "invalid",
			});
			expect((await reload(user.id))?.email).toBe(user.email);
			expect(
				fixture.stripeUpdates
					.filter((update) => update.id === user.stripeCustomerId)
					.map((update) => update.params.email),
			).toEqual([newEmail, user.email]);

			const second = address();
			fixture.currentUser = await reload(user.id);
			await start(user, second);
			await signOutAllDevices();
			expect(
				await database()
					.select()
					.from(emailChangeRequests)
					.where(eq(emailChangeRequests.userId, user.id)),
			).toHaveLength(0);
		});

		it("puts billing back when the change does not commit", async () => {
			const { finishEmailChange } = await actions();
			const user = await makeUser(address(), {
				stripeCustomerId: `cus_${id()}`,
			});
			const newEmail = address();
			await start(user, newEmail);
			fixture.failLoops = true;
			await expect(finishEmailChange(lastCode(newEmail))).rejects.toThrow(
				"Loops queue is down",
			);
			fixture.failLoops = false;
			expect((await reload(user.id))?.email).toBe(user.email);
			const updates = fixture.stripeUpdates
				.filter((update) => update.id === user.stripeCustomerId)
				.map((update) => update.params.email);
			expect(updates).toEqual([newEmail, user.email]);
		});

		it("changes the email when the billing customer no longer exists", async () => {
			const { finishEmailChange } = await actions();
			const user = await makeUser(address(), {
				stripeCustomerId: `cus_${id()}`,
			});
			const newEmail = address();
			await start(user, newEmail);
			fixture.stripeFails = "missing";
			expect(await finishEmailChange(lastCode(newEmail))).toMatchObject({
				status: "changed",
			});
			expect((await reload(user.id))?.email).toBe(newEmail);
		});

		it("keeps members on their organization's SSO domain", async () => {
			const domain = `corp-${id()}.example`;
			const owner = await makeUser();
			const organizationId = Organisation.OrganisationId.make(id());
			const workosOrganizationId = `org_${id()}`;
			await database().insert(organizations).values({
				id: organizationId,
				ownerId: owner.id,
				name: "SSO domain fixture",
				workosOrganizationId,
			});
			createdOrganizations.push(organizationId);
			const member = await makeUser(`member-${id()}@${domain}`);
			await database().insert(organizationMembers).values({
				id: id(),
				organizationId,
				userId: member.id,
				role: "member",
			});

			fixture.workosDomains.set(workosOrganizationId, [
				{ domain, state: "pending" },
			]);
			expect((await start(member, address())).status).toBe("sent");

			await database()
				.delete(emailChangeRequests)
				.where(eq(emailChangeRequests.userId, member.id));
			fixture.workosDomains.set(workosOrganizationId, [
				{ domain: domain.toUpperCase(), state: "verified" },
			]);
			expect(await start(member, address())).toEqual({ status: "managed" });

			const outsider = await makeUser(`outsider-${id()}@${domain}`);
			expect((await start(outsider, address())).status).toBe("sent");

			fixture.workosDown = true;
			await expect(start(member, address())).rejects.toThrow("WorkOS is down");
		});

		it("refuses a change confirmed after the address became managed by SSO", async () => {
			const { finishEmailChange } = await actions();
			const domain = `corp-${id()}.example`;
			const owner = await makeUser();
			const organizationId = Organisation.OrganisationId.make(id());
			const workosOrganizationId = `org_${id()}`;
			await database().insert(organizations).values({
				id: organizationId,
				ownerId: owner.id,
				name: "SSO domain fixture",
				workosOrganizationId,
			});
			createdOrganizations.push(organizationId);
			const member = await makeUser(`member-${id()}@${domain}`);
			await database().insert(organizationMembers).values({
				id: id(),
				organizationId,
				userId: member.id,
				role: "member",
			});
			const newEmail = address();
			await start(member, newEmail);
			fixture.workosDomains.set(workosOrganizationId, [
				{ domain, state: "verified" },
			]);
			expect(await finishEmailChange(lastCode(newEmail))).toEqual({
				status: "managed",
			});
			expect((await reload(member.id))?.email).toBe(member.email);
		});

		it("refuses a change when SSO links the account mid-change, and puts billing back", async () => {
			const { finishEmailChange } = await actions();
			const user = await makeUser(address(), {
				stripeCustomerId: `cus_${id()}`,
			});
			const newEmail = address();
			await start(user, newEmail);
			fixture.onStripeUpdate = async () => {
				await database()
					.insert(accounts)
					.values({
						id: id(),
						userId: user.id,
						type: "oauth",
						provider: "workos",
						providerAccountId: `prof_${id()}`,
					});
			};
			expect(await finishEmailChange(lastCode(newEmail))).toEqual({
				status: "managed",
			});
			expect((await reload(user.id))?.email).toBe(user.email);
			expect(
				fixture.stripeUpdates
					.filter((update) => update.id === user.stripeCustomerId)
					.map((update) => update.params.email),
			).toEqual([newEmail, user.email]);
		});

		it("drops pending invites to the old address", async () => {
			const { finishEmailChange } = await actions();
			const inviter = await makeUser();
			const user = await makeUser();
			const organizationId = Organisation.OrganisationId.make(id());
			const inviteId = id();
			const acceptedId = id();
			await database()
				.insert(organizationInvites)
				.values([
					{
						id: inviteId,
						organizationId,
						invitedEmail: user.email,
						invitedByUserId: inviter.id,
						role: "admin",
					},
					{
						id: acceptedId,
						organizationId,
						invitedEmail: user.email,
						invitedByUserId: inviter.id,
						role: "member",
						status: "accepted",
					},
				]);
			createdInvites.push(inviteId, acceptedId);
			const newEmail = address();
			await start(user, newEmail);
			expect((await finishEmailChange(lastCode(newEmail))).status).toBe(
				"changed",
			);
			const remaining = await database()
				.select({ id: organizationInvites.id })
				.from(organizationInvites)
				.where(inArray(organizationInvites.id, [inviteId, acceptedId]));
			expect(remaining.map((row) => row.id)).toEqual([acceptedId]);
		});

		it("refuses to accept an invite that is no longer pending", async () => {
			const { POST } = await import("@/app/api/invite/accept/route");
			const inviter = await makeUser();
			const user = await makeUser();
			const organizationId = Organisation.OrganisationId.make(id());
			const inviteId = id();
			await database().insert(organizationInvites).values({
				id: inviteId,
				organizationId,
				invitedEmail: user.email,
				invitedByUserId: inviter.id,
				role: "admin",
				status: "accepted",
			});
			createdInvites.push(inviteId);
			fixture.currentUser = user;
			const response = await POST(
				new Request("https://cap.test/api/invite/accept", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ inviteId }),
				}) as never,
			);
			expect(response.status).toBe(404);
			expect(
				await database()
					.select()
					.from(organizationMembers)
					.where(eq(organizationMembers.userId, user.id)),
			).toHaveLength(0);
		});

		it("sees an account stored with the Unicode spelling of a domain as taken", async () => {
			const { finishEmailChange } = await actions();
			const local = `legacy-${id()}`;
			const owner = await makeUser(`${local}@bücher.de`);
			const user = await makeUser();
			const requested = `${local}@xn--bcher-kva.de`;
			expect(await start(user, requested)).toEqual({
				status: "sent",
				email: requested,
			});
			expect(await finishEmailChange(lastCode(requested))).toEqual({
				status: "taken",
			});
			expect((await reload(owner.id))?.email).toBe(owner.email);
		});

		it("treats the trusted-proxy account as managed", async () => {
			const user = await makeUser();
			fixture.env.TRUSTED_PROXY_AUTH_HEADER = "x-owner";
			fixture.env.TRUSTED_PROXY_AUTH_SECRET = "secret";
			fixture.env.TRUSTED_PROXY_AUTH_EMAIL = user.email.toUpperCase();
			expect(await start(user, address())).toEqual({ status: "managed" });
			const other = await makeUser();
			expect((await start(other, address())).status).toBe("sent");
		});

		it("keeps the old email when billing cannot be updated, and recovers", async () => {
			const { finishEmailChange } = await actions();
			const user = await makeUser(address(), {
				stripeCustomerId: `cus_${id()}`,
			});
			const newEmail = address();
			await start(user, newEmail);
			const code = lastCode(newEmail);
			fixture.stripeFails = "down";
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
