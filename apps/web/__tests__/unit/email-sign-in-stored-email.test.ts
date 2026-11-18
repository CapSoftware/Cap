import { createHash } from "node:crypto";
import { authOptions } from "@cap/database/auth/auth-options";
import { normalizeSignInEmail } from "@cap/database/auth/domain-utils";

import { is, SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import NextAuth from "next-auth";
import { decode } from "next-auth/jwt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const env = vi.hoisted(() => ({
	NEXTAUTH_SECRET: "email-stored-match-test-secret-with-enough-entropy",
	WEB_URL: "https://cap.example",
	CAP_ALLOWED_SIGNUP_DOMAINS: undefined as string | undefined,
	CAP_BLOCKED_SIGNUP_DOMAINS: undefined as string | undefined,
}));

const store = vi.hoisted(() => ({
	tables: new Map<unknown, Record<string, unknown>[]>(),
	sentTo: [] as { email: string; code: string }[],
	skipNextUserSelect: false,
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => env,
	buildEnv: { NEXT_PUBLIC_IS_CAP: undefined },
}));

vi.mock("@cap/utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/utils")>()),
	STRIPE_AVAILABLE: () => false,
}));

vi.mock("@cap/database", () => ({ db: () => collatingDb }));

vi.mock("@cap/database/auth/sso", () => ({
	validateSsoSignIn: vi.fn(),
	provisionSsoMembership: vi.fn(),
}));

vi.mock("../../../../packages/database/auth/disposable-signup", () => ({
	isDisposableEmailSignup: async () => false,
}));

vi.mock("../../../../packages/database/loops/queue", () => ({
	enqueueLoopsSync: async () => {},
}));

vi.mock("@cap/database/emails/config", () => ({
	getEmailDeliveryStatus: () => ({ configured: true }),
	sendEmail: async ({
		email,
		react,
	}: {
		email: string;
		react: { code: string };
	}) => {
		store.sentTo.push({ email, code: react.code });
		return {};
	},
}));

vi.mock("@cap/database/emails/otp-email", () => ({
	OTPEmail: (props: { code: string; email: string }) => props,
}));

const { DrizzleAdapter } = await import(
	"../../../../packages/database/auth/drizzle-adapter"
);
const { organizations, users, verificationTokens } = await import(
	"@cap/database/schema"
);

// Equality as utf8mb4_0900_ai_ci compares these values: case and accents are ignored.
const collationKey = (value: unknown) =>
	String(value).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

const dialect = new MySqlDialect();

function matches(row: Row, condition: unknown) {
	if (!condition) return true;
	const { sql, params } = dialect.sqlToQuery(condition as never);
	const columns = [...sql.matchAll(/`(\w+)` = \?/g)].map((match) => match[1]);
	if (columns.length !== params.length || / or /i.test(sql)) {
		throw new Error(`Unsupported condition in test database: ${sql}`);
	}
	return columns.every(
		(column, index) =>
			collationKey(row[column as string]) === collationKey(params[index]),
	);
}

function rowsOf(table: unknown) {
	let rows = store.tables.get(table);
	if (!rows) {
		rows = [];
		store.tables.set(table, rows);
	}
	return rows;
}

function resultOf<T>(value: T) {
	const promise = Promise.resolve(value);
	return Object.assign(promise, { for: () => promise });
}

const collatingDb = {
	select: () => ({
		from: (table: unknown) => {
			let rows = [...rowsOf(table)];
			if (table === users && store.skipNextUserSelect) {
				store.skipNextUserSelect = false;
				rows = [];
			}
			const query = {
				innerJoin: () => {
					rows = [];
					return query;
				},
				where: (condition: unknown) => {
					rows = rows.filter((row) => matches(row, condition));
					return query;
				},
				limit: (count: number) => resultOf(rows.slice(0, count)),
				for: () => resultOf(rows),
			};
			return query;
		},
	}),
	insert: (table: unknown) => ({
		values: (values: Row) => {
			const rows = rowsOf(table);
			const duplicate =
				table === users
					? rows.find(
							(row) => collationKey(row.email) === collationKey(values.email),
						)
					: undefined;
			if (!duplicate) {
				rows.push({ ...values });
				return Object.assign(Promise.resolve([{ affectedRows: 1 }]), {
					onDuplicateKeyUpdate: async () => [{ affectedRows: 1 }],
				});
			}
			const rejected = Promise.reject(
				new Error("Duplicate entry for key email_idx"),
			);
			rejected.catch(() => {});
			return Object.assign(rejected, {
				onDuplicateKeyUpdate: async ({ set }: { set: Row }) => {
					for (const [column, value] of Object.entries(set)) {
						if (!is(value, SQL)) duplicate[column] = value;
					}
					return [{ affectedRows: 2 }];
				},
			});
		},
	}),
	update: (table: unknown) => ({
		set: (patch: Row) => ({
			where: (condition: unknown) => {
				const rows = rowsOf(table).filter((row) => matches(row, condition));
				for (const row of rows) Object.assign(row, patch);
				return Promise.resolve([{ affectedRows: rows.length }]);
			},
		}),
	}),
	delete: (table: unknown) => ({
		where: (condition: unknown) => {
			const rows = rowsOf(table);
			const kept = rows.filter((row) => !matches(row, condition));
			const removed = rows.length - kept.length;
			rows.splice(0, rows.length, ...kept);
			return Promise.resolve([{ affectedRows: removed }]);
		},
	}),
	transaction: async (run: (tx: unknown) => Promise<unknown>) =>
		run(collatingDb),
};

const csrfToken = "b".repeat(64);
const csrfCookie = `${csrfToken}|${createHash("sha256")
	.update(`${csrfToken}${env.NEXTAUTH_SECRET}`)
	.digest("hex")}`;

async function callNextAuth(request: {
	method: "GET" | "POST";
	nextauth: string[];
	query?: Record<string, string>;
	body?: Record<string, string>;
}) {
	let redirect = "";
	const headers = new Map<string, unknown>();
	const response = {
		status: () => response,
		getHeader: (name: string) => headers.get(name.toLowerCase()),
		setHeader: (name: string, value: unknown) => {
			headers.set(name.toLowerCase(), value);
			if (name.toLowerCase() === "location") redirect = String(value);
			return response;
		},
		json: (body: { url: string }) => {
			redirect = body.url;
		},
		send: () => {},
		end: () => {},
	};
	await NextAuth(
		{
			method: request.method,
			query: { nextauth: request.nextauth, ...request.query },
			body: request.body,
			cookies: { "__Host-next-auth.csrf-token": csrfCookie },
			headers: { host: "cap.example" },
		} as never,
		response as never,
		authOptions(),
	);
	const cookies = [headers.get("set-cookie") ?? []].flat().map(String);
	const sessionCookie = cookies
		.find((cookie) => cookie.startsWith("next-auth.session-token="))
		?.split(";")[0]
		?.slice("next-auth.session-token=".length);
	return { redirect, sessionCookie };
}

const requestCode = (email: string) =>
	callNextAuth({
		method: "POST",
		nextauth: ["signin", "email"],
		body: {
			email,
			csrfToken,
			callbackUrl: `${env.WEB_URL}/dashboard`,
			json: "true",
		},
	});

async function signInWithMailedCode(typedEmail: string) {
	await requestCode(typedEmail);
	const mail = store.sentTo.at(-1);
	if (!mail) throw new Error("No code was sent");
	const callbackEmail = normalizeSignInEmail(mail.email) ?? mail.email;
	const { redirect, sessionCookie } = await callNextAuth({
		method: "GET",
		nextauth: ["callback", "email"],
		query: {
			email: callbackEmail,
			token: mail.code,
			callbackUrl: `${env.WEB_URL}/dashboard`,
		},
	});
	const session = sessionCookie
		? await decode({ token: sessionCookie, secret: env.NEXTAUTH_SECRET })
		: null;
	return { mail, redirect, session };
}

function seedUser(id: string, email: string) {
	rowsOf(users).push({
		id,
		email,
		name: "Existing",
		emailVerified: new Date(0),
		image: null,
		activeOrganizationId: "",
	});
}

beforeEach(() => {
	vi.stubEnv("NEXTAUTH_URL", env.WEB_URL);
	vi.stubEnv("NODE_ENV", "production");
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	store.tables.clear();
	store.sentTo = [];
	store.skipNextUserSelect = false;
});

afterEach(() => vi.unstubAllEnvs());

describe("email sign-in against a case- and accent-insensitive users.email", () => {
	it("folds case and accents in the test database", async () => {
		seedUser("existing", "person@example.com");
		const rows = await collatingDb
			.select()
			.from(users)
			.where(
				(await import("drizzle-orm")).eq(users.email, "person@exámple.com"),
			)
			.limit(1);
		expect(rows.map((row) => row.id)).toEqual(["existing"]);
	});

	it("signs an internationalized domain in under its punycode address", async () => {
		seedUser("existing", "person@example.com");

		const { mail, session } = await signInWithMailedCode("person@exámple.com");

		expect(session?.id).toBeDefined();
		expect(session?.id).not.toBe("existing");
		expect(session?.email).toBe("person@xn--exmple-qta.com");
		expect(mail.email).toBe("person@xn--exmple-qta.com");
		expect(rowsOf(users).find((row) => row.id === "existing")?.email).toBe(
			"person@example.com",
		);
	});

	it("signs an existing account in with its own address", async () => {
		seedUser("owner", "owner@example.com");

		const { redirect, session } = await signInWithMailedCode(
			" Owner@Example.com ",
		);

		expect(redirect).toBe(`${env.WEB_URL}/dashboard`);
		expect(session?.id).toBe("owner");
		expect(rowsOf(users)).toHaveLength(1);
	});

	it("signs in an account stored with the Unicode spelling of its domain", async () => {
		seedUser("unicode-domain", "person@exämple.com");

		const { session } = await signInWithMailedCode("Person@Exämple.com");

		expect(session?.id).toBe("unicode-domain");
		expect(rowsOf(users)).toHaveLength(1);
	});

	it("signs in an account stored with mixed case", async () => {
		seedUser("mixed", "Mixed.Case@Example.com");

		const { session } = await signInWithMailedCode("mixed.case@example.com");

		expect(session?.id).toBe("mixed");
		expect(rowsOf(users)).toHaveLength(1);
	});

	it("refuses an address with a non-ASCII local part before sending a code", async () => {
		seedUser("existing", "person@example.com");

		const { redirect } = await requestCode("pérson@example.com");

		expect(redirect).toContain("error=");
		expect(store.sentTo).toEqual([]);
	});
});

describe("DrizzleAdapter email lookups", () => {
	const adapter = () => {
		const value = authOptions().adapter;
		if (!value?.getUserByEmail || !value.createUser) {
			throw new Error("Adapter missing email methods");
		}
		return value as Required<typeof value>;
	};

	it("returns only the account whose stored email matches exactly", async () => {
		seedUser("existing", "person@example.com");

		expect(await adapter().getUserByEmail("person@exámple.com")).toBeNull();
		expect((await adapter().getUserByEmail("Person@Example.com"))?.id).toBe(
			"existing",
		);
	});

	it("does not reuse an account whose stored email differs", async () => {
		seedUser("existing", "person@example.com");

		await expect(
			adapter().createUser({
				email: "person@exámple.com",
				emailVerified: new Date(),
				name: null,
				image: null,
			}),
		).rejects.toThrow();
		expect(rowsOf(users)).toHaveLength(1);
	});
});

describe("DrizzleAdapter stored-email checks", () => {
	const ssoIdentity = {
		organizationId: "org",
		workosOrganizationId: "workos-org",
		connectionId: "connection",
		profileId: "profile",
		email: "pérson@example.com",
	};

	it("keeps the stored email when an SSO insert meets an existing row", async () => {
		seedUser("existing", "person@example.com");
		rowsOf(organizations).push({ id: "org" });
		store.skipNextUserSelect = true;
		const adapter = DrizzleAdapter(collatingDb as never, {
			getSsoIdentity: () => ssoIdentity as never,
		});

		await expect(
			adapter.createUser?.({
				email: "pérson@example.com",
				emailVerified: new Date(),
				name: null,
				image: null,
			}),
		).rejects.toThrow();
		expect(rowsOf(users)).toEqual([
			expect.objectContaining({ id: "existing", email: "person@example.com" }),
		]);
	});

	it("leaves a verification token stored under a different identifier", async () => {
		rowsOf(verificationTokens).push({
			identifier: "person@example.com",
			token: "issued",
			expires: new Date(Date.now() + 60_000),
		});
		const adapter = DrizzleAdapter(collatingDb as never);

		expect(
			await adapter.useVerificationToken?.({
				identifier: "pérson@example.com",
				token: "other",
			}),
		).toBeNull();
		expect(rowsOf(verificationTokens)).toHaveLength(1);
	});
});

describe("normalizeSignInEmail", () => {
	it.each([
		["person@exámple.com", "person@xn--exmple-qta.com"],
		["Person@EXÁMPLE.com", "person@xn--exmple-qta.com"],
		["a@straße.de", "a@xn--strae-oqa.de"],
		["a@gmaıl.com", "a@xn--gmal-nza.com"],
		[" Person@Example.com ", "person@example.com"],
		["me＠ｃap.example", "me@cap.example"],
		["a@exa\u200Bmple.com", "a@example.com"],
	])("maps %j to %j", (input, expected) => {
		expect(normalizeSignInEmail(input)).toBe(expected);
	});

	it.each([
		"pérson@example.com",
		"straße@example.com",
		"\u202Cperson@example.com",
		"per\u0001son@example.com",
		"a@exam\u0001ple.com",
	])("refuses %j", (input) => {
		expect(normalizeSignInEmail(input)).toBeNull();
	});
});
