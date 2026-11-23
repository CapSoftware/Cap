import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/auth/[...nextauth]/route";

type RouteContext = { params: Promise<{ nextauth: string[] }> };

const mocks = vi.hoisted(() => ({
	isRateLimited: vi.fn<(ruleId: string, opts?: unknown) => Promise<boolean>>(),
	nextAuth: vi.fn<(request: NextRequest) => Promise<Response>>(),
}));

const env = vi.hoisted(() => ({
	WEB_URL: "https://cap.example",
	NEXTAUTH_SECRET: "test-one-tap-route-secret-with-sufficient-entropy",
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

const { googleOneTapNonceForSecret } = await import(
	"@cap/database/auth/google-one-tap"
);

const COOKIE_NAME = "__Host-cap-google-one-tap";
const FIRST = "first_secret-0123456789abcdefABCDEF012345";
const SECOND = "second_secret-0123456789abcdefABCDEF01234";

function context(): RouteContext {
	return {
		params: Promise.resolve({ nextauth: ["callback", "google-one-tap"] }),
	};
}

function credentialFor(secret: string) {
	const payload = Buffer.from(
		JSON.stringify({ nonce: googleOneTapNonceForSecret(secret) }),
	).toString("base64url");
	return `header.${payload}.signature`;
}

function callback(credentials: string[]) {
	const issuedAt = Math.floor(Date.now() / 1000) - 5;
	const body = new URLSearchParams({ csrfToken: "csrf", json: "true" });
	for (const credential of credentials) body.append("credential", credential);
	return new NextRequest(`${env.WEB_URL}/api/auth/callback/google-one-tap`, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			cookie: `${COOKIE_NAME}=${encodeURIComponent(
				`${FIRST}.${issuedAt}:${SECOND}.${issuedAt}`,
			)}`,
		},
		body,
	});
}

beforeEach(() => {
	mocks.isRateLimited.mockReset().mockResolvedValue(false);
	mocks.nextAuth
		.mockReset()
		.mockImplementation(async () => Response.json({ url: "/dashboard" }));
});

describe("Google One Tap callback route", () => {
	it("passes one credential to NextAuth and consumes only its nonce", async () => {
		const response = await POST(callback([credentialFor(FIRST)]), context());
		expect(mocks.nextAuth).toHaveBeenCalledTimes(1);
		const cookie = response.headers.get("set-cookie") ?? "";
		const value = decodeURIComponent(
			cookie.split(";")[0]?.split("=").slice(1).join("=") ?? "",
		);
		expect(value).not.toContain(FIRST);
		expect(value).toContain(SECOND);
		expect(mocks.isRateLimited.mock.calls[0]?.[0]).toBe(
			"rl_auth_google_one_tap",
		);
	});

	it("refuses a request that repeats the credential field", async () => {
		const response = await POST(
			callback(["junk", credentialFor(FIRST)]),
			context(),
		);
		expect(response.status).toBe(400);
		expect(mocks.nextAuth).not.toHaveBeenCalled();
	});

	it("refuses when rate limited", async () => {
		mocks.isRateLimited.mockResolvedValue(true);
		const response = await POST(callback([credentialFor(FIRST)]), context());
		expect(response.status).toBe(429);
		expect(mocks.nextAuth).not.toHaveBeenCalled();
	});
});
