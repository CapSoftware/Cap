import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/auth/[...nextauth]/route";
import { resetTorExitListCache } from "@/lib/tor-exit-gate";

type RouteContext = { params: Promise<{ nextauth: string[] }> };

const mocks = vi.hoisted(() => ({
	nextAuth: vi.fn<(request: NextRequest) => Promise<Response>>(),
}));

const env = vi.hoisted(() => ({
	WEB_URL: "https://cap.example",
	NEXTAUTH_SECRET: "test-email-route-secret-with-sufficient-entropy",
	CAP_TOR_EXIT_GATE: "deny" as string | undefined,
}));

vi.mock("@cap/env", () => ({ serverEnv: () => env }));
vi.mock("@cap/database/auth/auth-options", () => ({
	authOptions: () => ({ providers: [] }),
	decodeSessionToken: vi.fn(),
}));
vi.mock("@cap/database/auth/sso", () => ({ getWorkOS: vi.fn() }));
vi.mock("next-auth", () => ({ default: mocks.nextAuth }));
vi.mock("next-auth/jwt", () => ({ getToken: vi.fn(async () => null) }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/rate-limit")>()),
	isRateLimited: vi.fn(async () => false),
}));

const LISTED = "198.51.100.7";
const UNLISTED = "203.0.113.20";

const list = [
	...Array.from({ length: 60 }, (_, i) => `192.0.2.${i + 1}`),
	LISTED,
].join("\n");

function context(...nextauth: string[]): RouteContext {
	return { params: Promise.resolve({ nextauth }) };
}

function post(path: string, address: string, body: Record<string, string>) {
	return new NextRequest(`${env.WEB_URL}/api/auth/${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			"x-real-ip": address,
		},
		body: new URLSearchParams(body),
	});
}

function get(path: string, address: string) {
	return new NextRequest(`${env.WEB_URL}/api/auth/${path}`, {
		headers: { "x-real-ip": address },
	});
}

function blockedUrl(value: string | null | undefined) {
	const url = new URL(value ?? "");
	return { path: url.pathname, error: url.searchParams.get("error") };
}

beforeEach(() => {
	resetTorExitListCache();
	env.CAP_TOR_EXIT_GATE = "deny";
	vi.stubEnv("VERCEL", "1");
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(list)),
	);
	vi.spyOn(console, "warn").mockImplementation(() => {});
	mocks.nextAuth
		.mockReset()
		.mockImplementation(async () => Response.json({ handledBy: "next-auth" }));
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("sign-in from a Tor exit in deny mode", () => {
	it("refuses an email code request with the blocked notice", async () => {
		const response = await POST(
			post("signin/email", LISTED, {
				email: "person@example.com",
				csrfToken: "fixture-csrf-token",
				json: "true",
			}),
			context("signin", "email"),
		);

		expect(response.status).toBe(403);
		expect(mocks.nextAuth).not.toHaveBeenCalled();
		const { url } = (await response.json()) as { url: string };
		expect(blockedUrl(url)).toEqual({ path: "/login", error: "SignupBlocked" });
	});

	it("refuses an email code callback", async () => {
		const response = await GET(
			get("callback/email?email=person%40example.com&token=123456", LISTED),
			context("callback", "email"),
		);

		expect(response.status).toBe(302);
		expect(mocks.nextAuth).not.toHaveBeenCalled();
		expect(blockedUrl(response.headers.get("location"))).toEqual({
			path: "/login",
			error: "SignupBlocked",
		});
	});

	it("refuses starting and finishing an OAuth sign-in", async () => {
		const start = await POST(
			post("signin/google", LISTED, {
				csrfToken: "fixture-csrf-token",
				json: "true",
			}),
			context("signin", "google"),
		);
		const callback = await GET(
			get("callback/google?code=fixture&state=fixture", LISTED),
			context("callback", "google"),
		);
		const sso = await GET(
			get("callback/workos?code=fixture&state=fixture", LISTED),
			context("callback", "workos"),
		);

		expect(start.status).toBe(403);
		expect(callback.status).toBe(302);
		expect(sso.status).toBe(302);
		expect(blockedUrl(callback.headers.get("location")).error).toBe(
			"SignupBlocked",
		);
		expect(blockedUrl(sso.headers.get("location")).error).toBe("SignupBlocked");
		expect(mocks.nextAuth).not.toHaveBeenCalled();
	});

	it("refuses passkey and One Tap callbacks with a JSON notice", async () => {
		for (const provider of ["passkey", "google-one-tap"]) {
			const response = await POST(
				post(`callback/${provider}`, LISTED, {
					csrfToken: "fixture-csrf-token",
					json: "true",
				}),
				context("callback", provider),
			);
			expect(response.status).toBe(403);
			const { url } = (await response.json()) as { url: string };
			expect(blockedUrl(url).error).toBe("SignupBlocked");
		}
		expect(mocks.nextAuth).not.toHaveBeenCalled();
	});

	it("leaves session, CSRF and sign-out requests alone", async () => {
		for (const action of ["session", "csrf", "providers"]) {
			const response = await GET(get(action, LISTED), context(action));
			expect(response.status).toBe(200);
		}
		const signOut = await POST(
			post("signout", LISTED, { csrfToken: "fixture-csrf-token" }),
			context("signout"),
		);
		expect(signOut.status).toBe(200);
		expect(mocks.nextAuth).toHaveBeenCalledTimes(4);
	});
});

describe("sign-in from other addresses", () => {
	it("passes email, OAuth and passkey sign-in through to NextAuth", async () => {
		await POST(
			post("signin/email", UNLISTED, {
				email: "person@example.com",
				csrfToken: "fixture-csrf-token",
				json: "true",
			}),
			context("signin", "email"),
		);
		await GET(
			get("callback/google?code=fixture&state=fixture", UNLISTED),
			context("callback", "google"),
		);
		await POST(
			post("callback/passkey", UNLISTED, {
				csrfToken: "fixture-csrf-token",
				json: "true",
			}),
			context("callback", "passkey"),
		);

		expect(mocks.nextAuth).toHaveBeenCalledTimes(3);
	});

	it("passes a Tor exit through in log mode", async () => {
		env.CAP_TOR_EXIT_GATE = "log";

		const response = await POST(
			post("signin/email", LISTED, {
				email: "person@example.com",
				csrfToken: "fixture-csrf-token",
				json: "true",
			}),
			context("signin", "email"),
		);

		expect(response.status).toBe(200);
		expect(mocks.nextAuth).toHaveBeenCalledTimes(1);
	});

	it("passes a Tor exit through when the list cannot load", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("offline");
			}),
		);

		const response = await GET(
			get("callback/google?code=fixture&state=fixture", LISTED),
			context("callback", "google"),
		);

		expect(response.status).toBe(200);
		expect(mocks.nextAuth).toHaveBeenCalledTimes(1);
	});
});
