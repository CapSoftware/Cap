import { authOptions } from "@cap/database/auth/auth-options";
import type {
	SsoAuthContext,
	ValidatedSsoIdentity,
} from "@cap/database/auth/sso";
import { Organisation } from "@cap/web-domain";
import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { Account, NextAuthOptions } from "next-auth";
import type { Adapter } from "next-auth/adapters";
import { beforeEach, describe, expect, it, vi } from "vitest";

type AuthUser = {
	id: string;
	name: string;
	lastName: string | null;
	email: string;
	image: string | null;
	authSessionVersion: number;
};

const mocks = vi.hoisted(() => ({
	users: [] as AuthUser[],
	where: vi.fn(),
	select: vi.fn(),
	validate: vi.fn<(...args: unknown[]) => Promise<ValidatedSsoIdentity>>(),
	provision: vi.fn<(...args: unknown[]) => Promise<void>>(),
	adapter: vi.fn<
		(
			client: unknown,
			options: { getSsoIdentity: () => ValidatedSsoIdentity | null },
		) => Adapter
	>(() => ({})),
}));

const env = vi.hoisted(() => ({
	APPLE_CLIENT_ID: "so.cap.auth",
	APPLE_CLIENT_SECRET: "apple-secret",
	CAP_ALLOWED_SIGNUP_DOMAINS: undefined as string | undefined,
	GOOGLE_CLIENT_ID: "google-client",
	GOOGLE_CLIENT_SECRET: "google-secret",
	NEXTAUTH_SECRET: "next-auth-secret",
	RESEND_API_KEY: undefined,
	WORKOS_API_KEY: "workos-secret",
	WORKOS_CLIENT_ID: "workos-client",
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => env,
}));

vi.mock("@cap/database", () => ({
	db: () => ({ select: mocks.select }),
}));

vi.mock("@cap/database/auth/sso", () => ({
	validateSsoSignIn: mocks.validate,
	provisionSsoMembership: mocks.provision,
}));

vi.mock("../../../../packages/database/auth/drizzle-adapter", () => ({
	DrizzleAdapter: mocks.adapter,
}));

const WORKOS_ACCOUNT: Account = {
	provider: "workos",
	providerAccountId: "prof_01A",
	type: "oauth",
};
const PROFILE = {
	id: "prof_01A",
	organization_id: "org_01A",
	connection_id: "conn_01A",
	email: "alex@company.example",
};
const IDENTITY: ValidatedSsoIdentity = {
	organizationId: Organisation.OrganisationId.make("cap-org"),
	workosOrganizationId: PROFILE.organization_id,
	connectionId: PROFILE.connection_id,
	profileId: PROFILE.id,
	email: PROFILE.email,
};
const CONTEXT: SsoAuthContext = {
	actorId: null,
	intent: {
		version: 1,
		organizationId: IDENTITY.organizationId,
		workosOrganizationId: IDENTITY.workosOrganizationId,
		connectionId: IDENTITY.connectionId,
		actorId: null,
		issuedAt: 1,
		nonce: "a".repeat(32),
	},
};
const AUTHENTICATED_USER = { id: "authenticated-user", email: PROFILE.email };

function callbacksFor(options: NextAuthOptions) {
	const signIn = options.callbacks?.signIn;
	const jwt = options.callbacks?.jwt;
	if (!signIn || !jwt) throw new Error("Auth callbacks are missing");
	return { signIn, jwt };
}

describe("authOptions", () => {
	beforeEach(() => {
		env.APPLE_CLIENT_ID = "so.cap.auth";
		env.APPLE_CLIENT_SECRET = "apple-secret";
		env.WORKOS_CLIENT_ID = "workos-client";
		env.WORKOS_API_KEY = "workos-secret";
		env.CAP_ALLOWED_SIGNUP_DOMAINS = undefined;
		mocks.validate.mockReset().mockResolvedValue(IDENTITY);
		mocks.provision.mockReset().mockResolvedValue(undefined);
		mocks.adapter.mockClear();
		mocks.users = [
			{
				...AUTHENTICATED_USER,
				name: "Alex",
				lastName: null,
				image: null,
				authSessionVersion: 4,
			},
		];
		mocks.select.mockReset().mockImplementation(() => ({
			from: () => ({ where: mocks.where }),
		}));
		mocks.where.mockReset().mockImplementation((condition: SQL) => ({
			limit: async () => {
				const query = new MySqlDialect().sqlToQuery(condition);
				const match = /^`users`\.`(id|email)` = \?$/.exec(query.sql);
				if (!match?.[1]) throw new Error("Unexpected auth-user predicate");
				const column = match[1] as "id" | "email";
				return mocks.users.filter((user) => user[column] === query.params[0]);
			},
		}));
	});

	it("enables Apple when both OAuth credentials are configured", () => {
		const options = authOptions();
		const providers = options.providers.map((provider) => provider.id);

		expect(providers).toContain("apple");
		expect(options.cookies?.callbackUrl?.options.sameSite).toBe("none");
		expect(options.cookies?.pkceCodeVerifier?.options.sameSite).toBe("none");
	});

	it("does not expose a partially configured Apple provider", () => {
		env.APPLE_CLIENT_SECRET = "";

		const providers = authOptions().providers.map((provider) => provider.id);

		expect(providers).not.toContain("apple");
	});

	it.each(["WORKOS_CLIENT_ID", "WORKOS_API_KEY"] as const)(
		"does not offer SSO when %s is missing",
		(key) => {
			env[key] = "";

			expect(
				authOptions().providers.map((provider) => provider.id),
			).not.toContain("workos");
		},
	);

	// Without an explicit maxAge next-auth falls back to 24 hours, which is far
	// too long for a 6-digit code and contradicts what the OTP email tells users.
	it("expires email verification codes after the advertised 10 minutes", () => {
		const email = authOptions().providers.find(
			(provider) => provider.id === "email",
		);

		expect(email).toBeDefined();
		expect((email as { options?: { maxAge?: number } }).options?.maxAge).toBe(
			10 * 60,
		);
	});

	it("validates the raw WorkOS profile before exposing it to the adapter", async () => {
		const options = authOptions(CONTEXT);
		const adapter = options.adapter;
		const adapterOptions = mocks.adapter.mock.lastCall?.[1];
		const callbacks = callbacksFor(options);
		expect(adapter).toBeDefined();
		expect(adapterOptions?.getSsoIdentity()).toBeNull();

		await expect(
			callbacks.signIn({
				user: AUTHENTICATED_USER,
				account: WORKOS_ACCOUNT,
				profile: PROFILE,
			}),
		).resolves.toBe(true);

		expect(mocks.validate).toHaveBeenCalledWith(
			PROFILE,
			WORKOS_ACCOUNT.providerAccountId,
			CONTEXT,
		);
		expect(adapterOptions?.getSsoIdentity()).toEqual(IDENTITY);
		expect(mocks.provision).not.toHaveBeenCalled();
	});

	it("rejects failed validation without retaining an adapter identity", async () => {
		const options = authOptions(CONTEXT);
		const callbacks = callbacksFor(options);
		const adapter = options.adapter;
		const adapterOptions = mocks.adapter.mock.lastCall?.[1];
		expect(adapter).toBeDefined();
		await callbacks.signIn({
			user: AUTHENTICATED_USER,
			account: WORKOS_ACCOUNT,
			profile: PROFILE,
		});
		mocks.validate.mockRejectedValueOnce(new Error("Connection unavailable"));

		await expect(
			callbacks.signIn({
				user: AUTHENTICATED_USER,
				account: WORKOS_ACCOUNT,
				profile: PROFILE,
			}),
		).resolves.toBe("/login?error=SsoSignInFailed");

		expect(adapterOptions?.getSsoIdentity()).toBeNull();
		expect(mocks.provision).not.toHaveBeenCalled();
	});

	it("does not provision membership without a successful signIn callback", async () => {
		const callbacks = callbacksFor(authOptions(CONTEXT));

		await expect(
			callbacks.jwt({
				token: { id: "old-user", email: PROFILE.email },
				user: AUTHENTICATED_USER,
				account: WORKOS_ACCOUNT,
			}),
		).rejects.toThrow("not verified");

		expect(mocks.provision).not.toHaveBeenCalled();
		expect(mocks.select).not.toHaveBeenCalled();
	});

	it("preserves the signed mobile continuation when SSO validation fails", async () => {
		if (!CONTEXT.intent) throw new Error("Missing fixture intent");
		const returnTo = "/api/mobile/session/request?redirectUri=cap%3A%2F%2Fauth";
		const callbacks = callbacksFor(
			authOptions({
				...CONTEXT,
				intent: { ...CONTEXT.intent, returnTo },
			}),
		);
		mocks.validate.mockRejectedValueOnce(new Error("SSO was canceled"));

		const result = await callbacks.signIn({
			user: AUTHENTICATED_USER,
			account: WORKOS_ACCOUNT,
			profile: PROFILE,
		});

		if (typeof result !== "string") throw new Error("Missing error redirect");
		const redirect = new URL(result, "https://cap.example");
		expect(redirect.pathname).toBe("/login");
		expect(redirect.searchParams.get("error")).toBe("SsoSignInFailed");
		expect(redirect.searchParams.get("next")).toBe(returnTo);
		expect(mocks.provision).not.toHaveBeenCalled();
	});

	it("does not share validation between separate authOptions instances", async () => {
		const first = callbacksFor(authOptions(CONTEXT));
		const second = callbacksFor(authOptions(CONTEXT));
		await first.signIn({
			user: AUTHENTICATED_USER,
			account: WORKOS_ACCOUNT,
			profile: PROFILE,
		});

		await expect(
			second.jwt({
				token: { id: "old-user", email: PROFILE.email },
				user: AUTHENTICATED_USER,
				account: WORKOS_ACCOUNT,
			}),
		).rejects.toThrow("not verified");
		expect(mocks.provision).not.toHaveBeenCalled();
	});

	it("awaits membership provisioning before resolving a session token", async () => {
		const callbacks = callbacksFor(authOptions(CONTEXT));
		await callbacks.signIn({
			user: AUTHENTICATED_USER,
			account: WORKOS_ACCOUNT,
			profile: PROFILE,
		});
		let release: (() => void) | undefined;
		mocks.provision.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);

		const pending = callbacks.jwt({
			token: { id: "old-user", email: PROFILE.email },
			user: AUTHENTICATED_USER,
			account: WORKOS_ACCOUNT,
		});
		expect(mocks.provision).toHaveBeenCalledWith(
			AUTHENTICATED_USER.id,
			IDENTITY,
		);
		expect(mocks.select).not.toHaveBeenCalled();
		if (!release) throw new Error("Provisioning was not started");
		release();
		await expect(pending).resolves.toMatchObject({ id: AUTHENTICATED_USER.id });
	});

	it("does not resolve a token when membership provisioning fails", async () => {
		const callbacks = callbacksFor(authOptions(CONTEXT));
		await callbacks.signIn({
			user: AUTHENTICATED_USER,
			account: WORKOS_ACCOUNT,
			profile: PROFILE,
		});
		mocks.provision.mockRejectedValueOnce(new Error("SSO billing revoked"));

		await expect(
			callbacks.jwt({
				token: { id: "old-user", email: PROFILE.email },
				user: AUTHENTICATED_USER,
				account: WORKOS_ACCOUNT,
			}),
		).rejects.toThrow("SSO billing revoked");
		expect(mocks.select).not.toHaveBeenCalled();
	});

	it.each(["workos", "google", "apple"])(
		"anchors %s tokens to the authenticated user ID instead of token email",
		async (provider) => {
			const callbacks = callbacksFor(authOptions(CONTEXT));
			const account = { ...WORKOS_ACCOUNT, provider };
			mocks.users.push({
				id: "wrong-email-user",
				email: "stale@other.example",
				name: "Wrong identity",
				lastName: null,
				image: null,
				authSessionVersion: 9,
			});
			await callbacks.signIn({
				user: AUTHENTICATED_USER,
				account,
				profile: PROFILE,
			});

			const token = await callbacks.jwt({
				token: {
					id: "old-user",
					email: "stale@other.example",
					sub: "provider-sub",
				},
				user: AUTHENTICATED_USER,
				account,
			});

			expect(token).toMatchObject({
				id: AUTHENTICATED_USER.id,
				email: AUTHENTICATED_USER.email,
				name: "Alex",
				sessionVersion: 4,
			});
			expect(token.sub).toBeUndefined();
			if (provider !== "workos") {
				expect(mocks.validate).not.toHaveBeenCalled();
				expect(mocks.provision).not.toHaveBeenCalled();
			}
		},
	);
});
