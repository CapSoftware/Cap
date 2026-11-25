import type { AuthHooks } from "@cap/database/auth/auth-options";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/auth/[...nextauth]/route";
import { resetRangeListCache } from "@/lib/ip-reputation";
import {
	DATACENTER_ADDRESS,
	listFetch,
	UNLISTED_ADDRESS,
	VPN_ADDRESS,
} from "../fixtures/ip-reputation-lists";

type RouteContext = { params: Promise<{ nextauth: string[] }> };

const mocks = vi.hoisted(() => ({
	createsAccount: false,
	afterTasks: [] as (() => Promise<unknown>)[],
	nextAuth: vi.fn(),
}));

const env = vi.hoisted(() => ({
	WEB_URL: "https://cap.example",
	NEXTAUTH_SECRET: "test-new-account-route-secret-with-enough-entropy",
	CAP_TOR_EXIT_GATE: "off",
	CAP_IP_REPUTATION_LOG: "log" as string | undefined,
}));

vi.mock("@cap/env", () => ({ serverEnv: () => env }));
vi.mock("next/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("next/server")>()),
	after: (task: () => Promise<unknown>) => {
		mocks.afterTasks.push(task);
	},
}));
vi.mock("@cap/database/auth/auth-options", () => ({
	authOptions: (_sso: unknown, hooks?: AuthHooks) => ({ providers: [], hooks }),
	decodeSessionToken: vi.fn(),
}));
vi.mock("@cap/database/auth/sso", () => ({ getWorkOS: vi.fn() }));
vi.mock("@cap/database/auth/sso-state", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/database/auth/sso-state")>()),
	verifySsoLoginIntent: () => ({
		actorId: null,
		connectionId: "conn_test",
		returnTo: "/dashboard",
	}),
}));
vi.mock("next-auth", () => ({ default: mocks.nextAuth }));
vi.mock("next-auth/jwt", () => ({ getToken: vi.fn(async () => null) }));
vi.mock("@/lib/email-code-rate-limit", () => ({
	isEmailCodeSendLimited: vi.fn(async () => false),
	isEmailCodeVerifyLimited: vi.fn(async () => false),
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/rate-limit")>()),
	isRateLimited: vi.fn(async () => false),
}));

const fetchMock = vi.fn<typeof fetch>();

function context(...nextauth: string[]): RouteContext {
	return { params: Promise.resolve({ nextauth }) };
}

function callback(
	provider: string,
	address: string,
	options: { callbackUrl?: string; query?: string } = {},
) {
	const headers = new Headers({ "x-real-ip": address });
	if (options.callbackUrl) {
		headers.set(
			"cookie",
			`next-auth.callback-url=${encodeURIComponent(options.callbackUrl)}`,
		);
	}
	return GET(
		new NextRequest(
			`${env.WEB_URL}/api/auth/callback/${provider}${options.query ?? "?code=fixture&state=fixture"}`,
			{ headers },
		),
		context("callback", provider),
	);
}

async function runAfterTasks() {
	const tasks = mocks.afterTasks.splice(0);
	await Promise.all(tasks.map((task) => task()));
}

function newAccountLogs() {
	return vi
		.mocked(console.warn)
		.mock.calls.filter(
			([message]) =>
				message === "[ip-reputation] New account from a listed range",
		)
		.map(([, details]) => details);
}

beforeEach(() => {
	resetRangeListCache();
	env.CAP_IP_REPUTATION_LOG = "log";
	mocks.createsAccount = false;
	mocks.afterTasks = [];
	vi.stubEnv("VERCEL", "1");
	fetchMock.mockReset().mockImplementation(listFetch);
	vi.stubGlobal("fetch", fetchMock);
	vi.spyOn(console, "warn").mockImplementation(() => {});
	mocks.nextAuth
		.mockReset()
		.mockImplementation(
			async (
				_request: unknown,
				_context: unknown,
				options: { hooks?: AuthHooks },
			) => {
				if (mocks.createsAccount) options.hooks?.onUserCreated?.();
				return new Response(null, {
					status: 302,
					headers: { location: `${env.WEB_URL}/dashboard` },
				});
			},
		);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("new accounts from a listed range", () => {
	it("logs an email sign-up after the response", async () => {
		mocks.createsAccount = true;

		const response = await callback("email", DATACENTER_ADDRESS, {
			query: "?email=person%40example.com&token=123456",
		});

		expect(response.status).toBe(302);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(newAccountLogs()).toEqual([]);
		await runAfterTasks();
		expect(newAccountLogs()).toEqual([
			{
				surface: "web-sign-in",
				label: "datacenter",
				address: DATACENTER_ADDRESS,
				provider: "email",
				flow: "web",
			},
		]);
	});

	it.each(["google", "apple", "oidc"])(
		"logs a %s sign-up",
		async (provider) => {
			mocks.createsAccount = true;

			await callback(provider, VPN_ADDRESS);
			await runAfterTasks();

			expect(newAccountLogs()).toEqual([
				{
					surface: "web-sign-in",
					label: "vpn",
					address: VPN_ADDRESS,
					provider,
					flow: "web",
				},
			]);
		},
	);

	it("logs an SSO sign-up", async () => {
		mocks.createsAccount = true;

		await callback("workos", DATACENTER_ADDRESS);
		await runAfterTasks();

		expect(newAccountLogs()).toEqual([
			expect.objectContaining({
				label: "datacenter",
				provider: "workos",
			}),
		]);
	});

	it.each([
		["desktop", "/api/desktop/session/request?port=1234"],
		["mobile", "/api/mobile/session/request?provider=google"],
	])("tags a first %s sign-in", async (flow, path) => {
		mocks.createsAccount = true;

		await callback("google", DATACENTER_ADDRESS, {
			callbackUrl: `${env.WEB_URL}${path}`,
		});
		await runAfterTasks();

		expect(newAccountLogs()).toEqual([
			expect.objectContaining({ provider: "google", flow }),
		]);
	});

	it("logs nothing for a new account from another address", async () => {
		mocks.createsAccount = true;

		await callback("google", UNLISTED_ADDRESS);
		await runAfterTasks();

		expect(newAccountLogs()).toEqual([]);
	});

	it("does nothing when an existing account signs in", async () => {
		await callback("google", DATACENTER_ADDRESS);
		await POST(
			new NextRequest(`${env.WEB_URL}/api/auth/callback/passkey`, {
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					"x-real-ip": DATACENTER_ADDRESS,
				},
				body: new URLSearchParams({ csrfToken: "fixture" }),
			}),
			context("callback", "passkey"),
		);

		expect(mocks.afterTasks).toHaveLength(0);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(newAccountLogs()).toEqual([]);
	});

	it("does nothing when switched off", async () => {
		env.CAP_IP_REPUTATION_LOG = "off";
		mocks.createsAccount = true;

		await callback("google", DATACENTER_ADDRESS);

		expect(mocks.afterTasks).toHaveLength(0);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
