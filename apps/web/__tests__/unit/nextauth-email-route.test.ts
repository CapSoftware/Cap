import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/auth/[...nextauth]/route";

type RouteContext = { params: Promise<{ nextauth: string[] }> };

const mocks = vi.hoisted(() => ({
	isRateLimited: vi.fn<(ruleId: string, opts?: unknown) => Promise<boolean>>(),
	nextAuth: vi.fn<(request: NextRequest) => Promise<Response>>(),
}));

const env = vi.hoisted(() => ({
	WEB_URL: "https://cap.example",
	NEXTAUTH_SECRET: "test-email-route-secret-with-sufficient-entropy",
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
	isRateLimited: mocks.isRateLimited,
}));

function context(...nextauth: string[]): RouteContext {
	return { params: Promise.resolve({ nextauth }) };
}

function emailSignIn(email: string, extra: Record<string, string> = {}) {
	return new NextRequest(`${env.WEB_URL}/api/auth/signin/email`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			email,
			csrfToken: "fixture-csrf-token",
			callbackUrl: "/dashboard",
			json: "true",
			...extra,
		}),
	});
}

function emailCallback(query: Record<string, string>) {
	const url = new URL("/api/auth/callback/email", env.WEB_URL);
	url.search = new URLSearchParams(query).toString();
	return new NextRequest(url);
}

beforeEach(() => {
	mocks.isRateLimited.mockReset().mockResolvedValue(false);
	mocks.nextAuth.mockReset().mockImplementation(async (request) => {
		const body = request.method === "POST" ? await request.text() : "";
		return Response.json({ handledBy: "next-auth", body });
	});
});

describe("email sign-in requests", () => {
	it("passes an allowed request to NextAuth with its body intact", async () => {
		const response = await POST(
			emailSignIn("person@example.com"),
			context("signin", "email"),
		);

		expect(mocks.nextAuth).toHaveBeenCalledTimes(1);
		const body = (await response.json()) as { body: string };
		expect(new URLSearchParams(body.body).get("email")).toBe(
			"person@example.com",
		);
		expect(mocks.isRateLimited).toHaveBeenCalledTimes(1);
		const [ruleId, opts] = mocks.isRateLimited.mock.calls[0] ?? [];
		expect(ruleId).toBe("rl_auth_otp_send");
		expect((opts as { key: string }).key).toMatch(
			/^email-code-send:[0-9a-f]{64}$/,
		);
	});

	it("uses one bucket per normalized email", async () => {
		await POST(emailSignIn(" Person@Example.COM "), context("signin", "email"));
		await POST(emailSignIn("person@example.com"), context("signin", "email"));

		const [first, second] = mocks.isRateLimited.mock.calls.map(
			([, opts]) => (opts as { key: string }).key,
		);
		expect(second).toBe(first);
	});

	it("returns the NextAuth email error without sending when limited", async () => {
		mocks.isRateLimited.mockResolvedValue(true);

		const response = await POST(
			emailSignIn("person@example.com"),
			context("signin", "email"),
		);

		expect(response.status).toBe(429);
		expect(mocks.nextAuth).not.toHaveBeenCalled();
		const { url } = (await response.json()) as { url: string };
		expect(new URL(url).searchParams.get("error")).toBe("EmailSignin");
	});

	it("redirects non-JSON requests to the error page when limited", async () => {
		mocks.isRateLimited.mockResolvedValue(true);

		const response = await POST(
			emailSignIn("person@example.com", { json: "false" }),
			context("signin", "email"),
		);

		expect(response.status).toBe(302);
		expect(mocks.nextAuth).not.toHaveBeenCalled();
		const location = new URL(response.headers.get("location") ?? "");
		expect(location.pathname).toBe("/api/auth/error");
		expect(location.searchParams.get("error")).toBe("EmailSignin");
	});
});

describe("email code verification", () => {
	it("passes an allowed verification to NextAuth", async () => {
		const response = await GET(
			emailCallback({ email: "person@example.com", token: "123456" }),
			context("callback", "email"),
		);

		expect(mocks.nextAuth).toHaveBeenCalledTimes(1);
		expect(await response.json()).toMatchObject({ handledBy: "next-auth" });
		expect(mocks.isRateLimited.mock.calls[0]?.[0]).toBe("rl_auth_otp_verify");
	});

	it("redirects to the verification error without checking the code when limited", async () => {
		mocks.isRateLimited.mockResolvedValue(true);

		const response = await GET(
			emailCallback({ email: "person@example.com", token: "123456" }),
			context("callback", "email"),
		);

		expect(response.status).toBe(302);
		expect(mocks.nextAuth).not.toHaveBeenCalled();
		const location = new URL(response.headers.get("location") ?? "");
		expect(location.pathname).toBe("/api/auth/error");
		expect(location.searchParams.get("error")).toBe("Verification");
	});
});

describe("other auth routes", () => {
	it.each([
		["GET", ["session"]],
		["GET", ["csrf"]],
		["GET", ["providers"]],
		["POST", ["signin", "google"]],
		["GET", ["callback", "google"]],
		["GET", ["signin", "email"]],
		["POST", ["signout"]],
	] as const)("leaves %s %j untouched", async (method, segments) => {
		mocks.isRateLimited.mockResolvedValue(true);
		const request = new NextRequest(
			`${env.WEB_URL}/api/auth/${segments.join("/")}?email=person%40example.com&token=123456`,
			{
				method,
				...(method === "POST"
					? {
							headers: { "content-type": "application/x-www-form-urlencoded" },
							body: new URLSearchParams({ email: "person@example.com" }),
						}
					: {}),
			},
		);

		const handler = method === "POST" ? POST : GET;
		await handler(request, context(...segments));

		expect(mocks.isRateLimited).not.toHaveBeenCalled();
		expect(mocks.nextAuth).toHaveBeenCalledTimes(1);
	});
});
