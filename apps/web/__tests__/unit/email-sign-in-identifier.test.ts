import { createHash } from "node:crypto";
import { authOptions } from "@cap/database/auth/auth-options";
import {
	isBlockedAccountEmail,
	isEmailAllowedForSignup,
	isEmailBlockedFromSignup,
} from "@cap/database/auth/domain-utils";
import NextAuth from "next-auth";
import type {
	Adapter,
	AdapterUser,
	VerificationToken,
} from "next-auth/adapters";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FULLWIDTH_AT = "＠";
const FULLWIDTH_B = "ｂ";
const FULLWIDTH_C = "ｃ";

type StoredUser = AdapterUser & { email: string };

const mocks = vi.hoisted(() => ({
	users: [] as { id: string; email: string }[],
	tokens: [] as { identifier: string; token: string; expires: Date }[],
	createdUsers: [] as string[],
	sentTo: [] as { email: string; code: string }[],
}));

const env = vi.hoisted(() => ({
	NEXTAUTH_SECRET: "email-identifier-test-secret-with-enough-entropy",
	WEB_URL: "https://cap.example",
	CAP_ALLOWED_SIGNUP_DOMAINS: undefined as string | undefined,
	CAP_BLOCKED_SIGNUP_DOMAINS: undefined as string | undefined,
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => env,
	buildEnv: { NEXT_PUBLIC_IS_CAP: undefined },
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: () => ({ limit: async () => [] }),
			}),
		}),
	}),
}));

vi.mock("@cap/database/auth/sso", () => ({
	validateSsoSignIn: vi.fn(),
	provisionSsoMembership: vi.fn(),
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
		mocks.sentTo.push({ email, code: react.code });
		return {};
	},
}));

vi.mock("@cap/database/emails/otp-email", () => ({
	OTPEmail: (props: { code: string; email: string }) => props,
}));

vi.mock("../../../../packages/database/auth/drizzle-adapter", () => ({
	DrizzleAdapter: (): Adapter => {
		const byEmail = (email: string) =>
			mocks.users.find((user) => user.email === email.toLowerCase()) ?? null;
		const asAdapterUser = (user: { id: string; email: string }) =>
			({ ...user, emailVerified: null }) as StoredUser;
		return {
			async createUser(user) {
				const created = {
					id: `user-${mocks.users.length + 1}`,
					email: user.email,
				};
				mocks.users.push(created);
				mocks.createdUsers.push(user.email);
				return asAdapterUser(created);
			},
			async getUser(id) {
				const user = mocks.users.find((row) => row.id === id);
				return user ? asAdapterUser(user) : null;
			},
			async getUserByEmail(email) {
				const user = byEmail(email);
				return user ? asAdapterUser(user) : null;
			},
			async getUserByAccount() {
				return null;
			},
			async updateUser(user) {
				const existing = mocks.users.find((row) => row.id === user.id);
				if (!existing) throw new Error("Unknown user");
				return asAdapterUser(existing);
			},
			async linkAccount() {},
			async createSession() {
				throw new Error("Sessions are JWT based");
			},
			async getSessionAndUser() {
				return null;
			},
			async updateSession() {
				return null;
			},
			async deleteSession() {},
			async createVerificationToken(token: VerificationToken) {
				mocks.tokens.push(token);
				return token;
			},
			async useVerificationToken({ identifier, token }) {
				const index = mocks.tokens.findIndex(
					(row) => row.identifier === identifier && row.token === token,
				);
				if (index === -1) return null;
				const [row] = mocks.tokens.splice(index, 1);
				return row ?? null;
			},
		};
	},
}));

const csrfToken = "a".repeat(64);
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
	return redirect;
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

const verifyCode = (email: string, token: string) =>
	callNextAuth({
		method: "GET",
		nextauth: ["callback", "email"],
		query: { email, token, callbackUrl: `${env.WEB_URL}/dashboard` },
	});

beforeEach(() => {
	vi.stubEnv("NEXTAUTH_URL", env.WEB_URL);
	vi.stubEnv("NODE_ENV", "production");
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	env.CAP_ALLOWED_SIGNUP_DOMAINS = undefined;
	env.CAP_BLOCKED_SIGNUP_DOMAINS = undefined;
	mocks.users = [];
	mocks.tokens = [];
	mocks.createdUsers = [];
	mocks.sentTo = [];
});

afterEach(() => vi.unstubAllEnvs());

describe("email sign-in identifiers", () => {
	it.each([
		["an ASCII address", "Me@Blocked.example"],
		["a fullwidth at sign", `me${FULLWIDTH_AT}blocked.example`],
		["a fullwidth domain letter", `me@${FULLWIDTH_B}locked.example`],
	])("refuses a blocked domain written with %s", async (_, email) => {
		env.CAP_BLOCKED_SIGNUP_DOMAINS = "blocked.example";

		const redirect = await requestCode(email);

		expect(redirect).toContain("error=SignupBlocked");
		expect(mocks.tokens).toEqual([]);
		expect(mocks.sentTo).toEqual([]);
	});

	it("stores, emails and creates the account under the address Cap checked", async () => {
		const email = `Me@${FULLWIDTH_C}ap.example`;

		expect(await requestCode(email)).toContain("/verify-request");
		expect(mocks.tokens.map((row) => row.identifier)).toEqual([
			"me@cap.example",
		]);
		const sent = mocks.sentTo.at(-1);
		expect(sent?.email).toBe("me@cap.example");

		const redirect = await verifyCode("me@cap.example", sent?.code ?? "");

		expect(redirect).toBe(`${env.WEB_URL}/dashboard`);
		expect(mocks.createdUsers).toEqual(["me@cap.example"]);
	});

	it("signs an existing ASCII account back in without creating another", async () => {
		mocks.users = [{ id: "existing", email: "person@example.com" }];

		expect(await requestCode(" Person@Example.com ")).toContain(
			"/verify-request",
		);
		const sent = mocks.sentTo.at(-1);
		expect(sent?.email).toBe("person@example.com");

		const redirect = await verifyCode("person@example.com", sent?.code ?? "");

		expect(redirect).toBe(`${env.WEB_URL}/dashboard`);
		expect(mocks.createdUsers).toEqual([]);
	});

	it("still refuses new addresses outside the allowed domains", async () => {
		env.CAP_ALLOWED_SIGNUP_DOMAINS = "company.example";

		expect(await requestCode("me@bücher.example")).toContain(
			"error=AccessDenied",
		);
		expect(await requestCode("me@other.example")).toContain(
			"error=AccessDenied",
		);
		expect(mocks.sentTo).toEqual([]);
	});
});

describe("signup domain rules", () => {
	it("matches blocked domains and addresses after compatibility normalization", () => {
		expect(
			isEmailBlockedFromSignup(`me${FULLWIDTH_AT}example.com`, "example.com"),
		).toBe(true);
		expect(
			isEmailBlockedFromSignup(
				`me@${FULLWIDTH_B}locked.example`,
				"me@blocked.example",
			),
		).toBe(true);
		expect(
			isEmailBlockedFromSignup("me@other.example", "blocked.example"),
		).toBe(false);
	});

	it("refuses stored accounts whose address normalizes to a blocked domain", () => {
		env.CAP_BLOCKED_SIGNUP_DOMAINS = "blocked.example";

		expect(isBlockedAccountEmail(`me@${FULLWIDTH_B}locked.example`)).toBe(true);
		expect(isBlockedAccountEmail("me@blocked.example")).toBe(true);
		expect(isBlockedAccountEmail("me@other.example")).toBe(false);
	});

	it("applies the allowlist to the normalized address and fails closed otherwise", () => {
		expect(
			isEmailAllowedForSignup(`me${FULLWIDTH_AT}example.com`, "example.com"),
		).toBe(true);
		expect(isEmailAllowedForSignup("me@bücher.example", "example.com")).toBe(
			false,
		);
		expect(isEmailAllowedForSignup("not-an-email", "example.com")).toBe(false);
	});
});
