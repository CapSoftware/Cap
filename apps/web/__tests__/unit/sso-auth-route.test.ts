import type { SsoAuthContext } from "@cap/database/auth/sso";
import {
	createSsoLoginIntent,
	SSO_INTENT_MAX_AGE,
	ssoIntentCookie,
	verifySsoLoginIntent,
} from "@cap/database/auth/sso-state";
import { NextRequest } from "next/server";
import type { NextAuthOptions } from "next-auth";
import type { JWT } from "next-auth/jwt";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/auth/[...nextauth]/route";

type RouteContext = { params: Promise<{ nextauth: string[] }> };

const mocks = vi.hoisted(() => ({
	authOptions: vi.fn<(context?: SsoAuthContext) => NextAuthOptions>(() => ({
		providers: [],
	})),
	decode: vi.fn(),
	getToken: vi.fn<() => Promise<JWT | null>>(),
	nextAuth:
		vi.fn<
			(
				request: NextRequest,
				context: RouteContext,
				options: NextAuthOptions,
			) => Promise<Response>
		>(),
}));

const env = vi.hoisted(() => ({
	WEB_URL: "https://cap.example",
	NEXTAUTH_SECRET: "test-sso-route-secret-with-sufficient-entropy",
}));

vi.mock("@cap/env", () => ({ serverEnv: () => env }));
vi.mock("@cap/database/auth/auth-options", () => ({
	authOptions: mocks.authOptions,
	decodeSessionToken: mocks.decode,
}));
vi.mock("next-auth", () => ({ default: mocks.nextAuth }));
vi.mock("next-auth/jwt", () => ({ getToken: mocks.getToken }));

const RETURN_TO = "/api/mobile/session/request?redirectUri=cap%3A%2F%2Fauth";
const INTENT = {
	organizationId: "caporganization",
	workosOrganizationId: "org_verified",
	connectionId: "conn_verified",
	actorId: null,
	returnTo: RETURN_TO,
};

function makeRequest(
	options: {
		action?: "signin" | "callback";
		provider?: string;
		method?: "GET" | "POST";
		intent?: string | null;
		body?: string | URLSearchParams;
		contentType?: string;
		callbackCookie?: string;
		query?: Record<string, string> | URLSearchParams;
	} = {},
) {
	const action = options.action ?? "signin";
	const provider = options.provider ?? "workos";
	const method = options.method ?? (action === "callback" ? "GET" : "POST");
	const url = new URL(`/api/auth/${action}/${provider}`, env.WEB_URL);
	if (options.query) {
		url.search = new URLSearchParams(options.query).toString();
	} else if (action === "signin") {
		url.searchParams.set("connection", INTENT.connectionId);
	}
	const intent =
		options.intent === undefined
			? createSsoLoginIntent(INTENT, env.NEXTAUTH_SECRET)
			: options.intent;
	const cookieName = ssoIntentCookie(true).name;
	const cookies = [
		...(intent ? [`${cookieName}=${intent}`] : []),
		...(options.callbackCookie
			? [`next-auth.callback-url=${encodeURIComponent(options.callbackCookie)}`]
			: []),
	];
	const headers = new Headers({ cookie: cookies.join("; ") });
	if (method === "POST") {
		headers.set(
			"content-type",
			options.contentType ?? "application/x-www-form-urlencoded",
		);
	}
	const request = new NextRequest(url, {
		method,
		headers,
		body:
			method === "POST"
				? (options.body ??
					new URLSearchParams({
						json: "true",
						callbackUrl: RETURN_TO,
						csrfToken: "fixture-csrf-token",
					}))
				: undefined,
	});
	const context: RouteContext = {
		params: Promise.resolve({ nextauth: [action, provider] }),
	};
	return { request, context, intent };
}

async function errorUrl(response: Response) {
	if (response.headers.get("content-type")?.includes("application/json")) {
		const body = (await response.json()) as { url: string };
		return new URL(body.url);
	}
	return new URL(response.headers.get("location") ?? "");
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getToken.mockReset().mockResolvedValue(null);
	mocks.nextAuth.mockReset().mockImplementation(async () => {
		return new Response(null, {
			status: 302,
			headers: {
				location: "/dashboard",
				"set-cookie": "next-auth.session-token=verified-session; Path=/",
			},
		});
	});
});

describe("SSO auth request boundary", () => {
	it.each(["missing", "tampered", "expired"])(
		"returns a JSON sign-in error for a %s intent without calling NextAuth",
		async (reason) => {
			const intent =
				reason === "missing"
					? null
					: reason === "tampered"
						? "tampered.invalid-signature"
						: createSsoLoginIntent(
								INTENT,
								env.NEXTAUTH_SECRET,
								Date.now() - (SSO_INTENT_MAX_AGE + 1) * 1000,
							);
			const { request, context } = makeRequest({ intent });

			const response = await POST(request, context);
			const redirect = await errorUrl(response);

			expect(response.status).toBe(200);
			expect(response.headers.get("location")).toBeNull();
			expect(redirect.origin).toBe(env.WEB_URL);
			expect(redirect.pathname).toBe("/login");
			expect(redirect.searchParams.get("error")).toBe("SsoSessionExpired");
			expect(redirect.searchParams.get("next")).toBe(RETURN_TO);
			expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
			expect(mocks.nextAuth).not.toHaveBeenCalled();
			expect(mocks.authOptions).not.toHaveBeenCalled();
			expect(request.bodyUsed).toBe(false);
		},
	);

	it("supports the JSON body contract without consuming the request", async () => {
		const { request, context } = makeRequest({
			intent: null,
			contentType: "application/json",
			body: JSON.stringify({ json: "true", callbackUrl: RETURN_TO }),
		});

		const response = await POST(request, context);

		expect(response.headers.get("content-type")).toContain("application/json");
		expect((await errorUrl(response)).searchParams.get("next")).toBe(RETURN_TO);
		expect(request.bodyUsed).toBe(false);
	});

	it.each([
		"https://attacker.example/steal",
		"//attacker.example/steal",
		"/\\attacker.example/steal",
		"https://cap.example//attacker.example/steal",
	])("does not preserve an unsafe callback URL %s", async (callbackUrl) => {
		const { request, context } = makeRequest({
			intent: null,
			body: new URLSearchParams({ json: "true", callbackUrl }),
		});

		const redirect = await errorUrl(await POST(request, context));

		expect(redirect.origin).toBe(env.WEB_URL);
		expect(redirect.searchParams.get("next")).toBeNull();
	});

	it("uses a 303 redirect for a document form instead of replaying its POST", async () => {
		const { request, context } = makeRequest({
			intent: null,
			body: new URLSearchParams({ callbackUrl: RETURN_TO }),
		});

		const response = await POST(request, context);

		expect(response.status).toBe(303);
		expect((await errorUrl(response)).searchParams.get("next")).toBe(RETURN_TO);
	});

	it("handles malformed JSON as a failed document request", async () => {
		const { request, context } = makeRequest({
			intent: null,
			contentType: "application/json",
			body: "{malformed",
		});

		const response = await POST(request, context);

		expect(response.status).toBe(303);
		expect((await errorUrl(response)).searchParams.get("next")).toBeNull();
		expect(mocks.nextAuth).not.toHaveBeenCalled();
	});

	it.each<Record<string, string>>([
		{},
		{ connection: "" },
		{ organization: INTENT.workosOrganizationId },
		{ organization: "org_other" },
		{ connection: "conn_other" },
	])("rejects a missing or changed connection selector %j", async (query) => {
		const { request, context } = makeRequest({ query });

		const response = await POST(request, context);

		expect((await errorUrl(response)).searchParams.get("error")).toBe(
			"SsoSessionExpired",
		);
		expect(mocks.nextAuth).not.toHaveBeenCalled();
	});

	it.each([
		["organization", INTENT.workosOrganizationId],
		["organization", "org_other"],
		["provider", "GoogleOAuth"],
		["domain", "company.example"],
		["redirect_uri", "https://attacker.example/callback"],
		["client_id", "client_other"],
		["response_type", "token"],
		["state", "injected-state"],
		["code_challenge", "injected-challenge"],
		["unknown", ""],
	])(
		"rejects an extra authorization query parameter %s",
		async (key, value) => {
			const { request, context } = makeRequest({
				query: new URLSearchParams([
					["connection", INTENT.connectionId],
					[key, value],
				]),
			});

			const response = await POST(request, context);

			expect((await errorUrl(response)).searchParams.get("error")).toBe(
				"SsoSessionExpired",
			);
			expect(mocks.nextAuth).not.toHaveBeenCalled();
		},
	);

	it.each([INTENT.connectionId, "conn_other", ""])(
		"rejects duplicate connection parameters even when the second is %s",
		async (second) => {
			const { request, context } = makeRequest({
				query: new URLSearchParams([
					["connection", INTENT.connectionId],
					["connection", second],
				]),
			});

			const response = await POST(request, context);

			expect((await errorUrl(response)).searchParams.get("error")).toBe(
				"SsoSessionExpired",
			);
			expect(mocks.nextAuth).not.toHaveBeenCalled();
		},
	);

	it("rejects a changed browser account and preserves the signed return path", async () => {
		mocks.getToken.mockResolvedValueOnce({ id: "different-user" });
		const { request, context } = makeRequest({
			body: new URLSearchParams({
				json: "true",
				callbackUrl: "/different-return",
			}),
		});

		const redirect = await errorUrl(await POST(request, context));

		expect(redirect.searchParams.get("error")).toBe("SsoSessionExpired");
		expect(redirect.searchParams.get("next")).toBe(RETURN_TO);
		expect(mocks.nextAuth).not.toHaveBeenCalled();
	});

	it("accepts connection-only authorization with the intact POST and signed tenant identity", async () => {
		const intent = createSsoLoginIntent(
			{ ...INTENT, actorId: "signed-in-user" },
			env.NEXTAUTH_SECRET,
		);
		mocks.getToken.mockResolvedValueOnce({ id: "signed-in-user" });
		const { request, context } = makeRequest({ intent });
		let receivedBody = "";
		mocks.nextAuth.mockImplementationOnce(async (receivedRequest) => {
			receivedBody = await receivedRequest.text();
			return Response.json({ url: "https://api.workos.com/sso/authorize" });
		});

		const response = await POST(request, context);

		expect(new URLSearchParams(receivedBody).get("csrfToken")).toBe(
			"fixture-csrf-token",
		);
		expect(mocks.authOptions).toHaveBeenCalledWith({
			intent: verifySsoLoginIntent(intent, env.NEXTAUTH_SECRET),
			actorId: "signed-in-user",
		});
		expect(mocks.nextAuth).toHaveBeenCalledWith(request, context, {
			providers: [],
		});
		expect(response.headers.get("set-cookie")).toBeNull();
	});

	it("expires only the intent after callback and preserves the session cookie", async () => {
		const { request, context } = makeRequest({
			action: "callback",
			query: { code: "fixture-code", state: "fixture-state" },
		});

		const response = await GET(request, context);

		expect(response.headers.get("location")).toBe("/dashboard");
		expect(response.headers.get("set-cookie")).toContain(
			"next-auth.session-token=verified-session",
		);
		expect(response.headers.get("set-cookie")).toContain(
			`${ssoIntentCookie(true).name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`,
		);
	});

	it.each([
		"/api/auth/error?error=OAuthCallback",
		"https://cap.example/api/auth/error?error=Callback",
		"/api/auth/signin",
		"/login?error=SsoSignInFailed",
	])(
		"preserves mobile continuation after NextAuth redirects to %s",
		async (location) => {
			mocks.nextAuth.mockResolvedValueOnce(
				new Response(null, { status: 302, headers: { location } }),
			);
			const { request, context } = makeRequest({ action: "callback" });

			const redirect = await errorUrl(await GET(request, context));

			expect(redirect.origin).toBe(env.WEB_URL);
			expect(redirect.pathname).toBe("/login");
			expect(redirect.searchParams.get("error")).toBe("SsoSignInFailed");
			expect(redirect.searchParams.get("next")).toBe(RETURN_TO);
		},
	);

	it("does not append the signed continuation to an external redirect", async () => {
		const location = "https://attacker.example/login?error=Callback";
		mocks.nextAuth.mockResolvedValueOnce(
			new Response(null, { status: 302, headers: { location } }),
		);
		const { request, context } = makeRequest({ action: "callback" });

		const response = await GET(request, context);

		expect(response.headers.get("location")).toBe(location);
	});

	it("recovers a safe mobile continuation cookie after callback intent expiry", async () => {
		const { request, context } = makeRequest({
			action: "callback",
			intent: createSsoLoginIntent(
				INTENT,
				env.NEXTAUTH_SECRET,
				Date.now() - (SSO_INTENT_MAX_AGE + 1) * 1000,
			),
			callbackCookie: `${env.WEB_URL}${RETURN_TO}`,
		});

		const response = await GET(request, context);
		const redirect = await errorUrl(response);

		expect(response.status).toBe(303);
		expect(redirect.searchParams.get("error")).toBe("SsoSessionExpired");
		expect(redirect.searchParams.get("next")).toBe(RETURN_TO);
		expect(mocks.nextAuth).not.toHaveBeenCalled();
	});

	it("does not use an external continuation cookie after missing intent", async () => {
		const { request, context } = makeRequest({
			action: "callback",
			intent: null,
			callbackCookie: "https://attacker.example/steal",
		});

		const redirect = await errorUrl(await GET(request, context));

		expect(redirect.origin).toBe(env.WEB_URL);
		expect(redirect.searchParams.get("next")).toBeNull();
	});

	it("does not apply SSO intent checks to another provider", async () => {
		const { request, context } = makeRequest({
			provider: "google",
			intent: null,
		});

		const response = await POST(request, context);

		expect(mocks.getToken).not.toHaveBeenCalled();
		expect(mocks.authOptions).toHaveBeenCalledWith();
		expect(mocks.nextAuth).toHaveBeenCalledWith(request, context, {
			providers: [],
		});
		expect(response.headers.get("set-cookie")).not.toContain("cap-sso-intent");
	});
});
