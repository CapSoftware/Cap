import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const isRateLimited = vi.hoisted(() => vi.fn(async () => false));
vi.mock("@/lib/rate-limit", () => ({
	isRateLimited,
	RATE_LIMIT_IDS: {
		AGENT_TOKEN_EXCHANGE: "rl_agent_token_exchange",
		AGENT_AUTHORIZATION: "rl_agent_authorization",
		AGENT_UNLOCK: "rl_agent_unlock",
		AGENT_LOOM_IMPORT: "rl_loom_import_per_user",
	},
}));

describe("agent API handler", () => {
	let GET: typeof import("@/app/api/v1/[...route]/route").GET;
	let OPTIONS: typeof import("@/app/api/v1/[...route]/route").OPTIONS;
	let POST: typeof import("@/app/api/v1/[...route]/route").POST;
	let PATCH: typeof import("@/app/api/v1/[...route]/route").PATCH;
	let PUT: typeof import("@/app/api/v1/[...route]/route").PUT;
	let DELETE: typeof import("@/app/api/v1/[...route]/route").DELETE;

	beforeAll(async () => {
		Object.assign(process.env, {
			NEXT_PUBLIC_WEB_URL: "http://localhost",
			WEB_URL: "http://localhost",
			DATABASE_URL: "mysql://unused:unused@127.0.0.1:3306/unused",
			NEXTAUTH_SECRET: "synthetic-test-secret-that-is-long-enough",
			NEXTAUTH_URL: "http://localhost",
			CAP_AWS_BUCKET: "synthetic",
			CAP_AWS_REGION: "us-east-1",
			CAP_AWS_ACCESS_KEY: "synthetic",
			CAP_AWS_SECRET_KEY: "synthetic",
			NODE_ENV: "test",
		});
		const route = await import("@/app/api/v1/[...route]/route");
		GET = route.GET;
		OPTIONS = route.OPTIONS;
		POST = route.POST;
		PATCH = route.PATCH;
		PUT = route.PUT;
		DELETE = route.DELETE;
	});

	it("handles CORS preflight without authentication", async () => {
		const response = await OPTIONS(
			new Request("http://localhost/api/v1/caps", {
				method: "OPTIONS",
				headers: {
					Origin: "http://localhost",
					"Access-Control-Request-Method": "GET",
					"Access-Control-Request-Headers": "x-cap-confirmation",
				},
			}),
		);
		expect(response.status).toBeLessThan(400);
		expect(response.headers.get("access-control-allow-headers")).toContain(
			"X-Cap-Confirmation",
		);
	});

	it("returns the stable authentication error without a credential", async () => {
		for (const path of ["/api/v1/caps", "/api/v1/auth/status"]) {
			const response = await GET(new Request(`http://localhost${path}`));
			const body = await response.json();

			expect(response.status).toBe(401);
			expect(body).toMatchObject({
				_tag: "AgentAuthenticationError",
				code: "AUTH_REQUIRED",
				retryable: false,
				retryAfterMs: null,
			});
			expect(body.requestId).toEqual(expect.any(String));
		}
	});

	it("rate limits unauthenticated authorization-code exchange before database access", async () => {
		isRateLimited.mockResolvedValueOnce(true);
		const response = await POST(
			new Request("http://localhost/api/v1/auth/token", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					code: "c".repeat(43),
					codeVerifier: "v".repeat(43),
					redirectUri: "http://127.0.0.1:49152/callback",
				}),
			}),
		);
		const body = await response.json();
		expect(response.status).toBe(429);
		expect(body).toMatchObject({
			code: "RATE_LIMITED",
			retryable: true,
			retryAfterMs: 60_000,
		});
	});

	it("authenticates unlocks and mutations before executing them", async () => {
		const requests = [
			POST(
				new Request("http://localhost/api/v1/caps/cap_synthetic/unlock", {
					method: "POST",
					headers: { "Content-Type": "text/plain" },
					body: "not-a-real-password",
				}),
			),
			POST(
				new Request("http://localhost/api/v1/caps/cap_synthetic/comments", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ content: "Synthetic comment" }),
				}),
			),
			PATCH(
				new Request("http://localhost/api/v1/caps/cap_synthetic", {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title: "Synthetic title" }),
				}),
			),
			PUT(
				new Request("http://localhost/api/v1/caps/cap_synthetic/password", {
					method: "PUT",
					headers: { "Content-Type": "text/plain" },
					body: "not-a-real-password",
				}),
			),
			DELETE(
				new Request("http://localhost/api/v1/caps/cap_synthetic", {
					method: "DELETE",
				}),
			),
			PUT(
				new Request("http://localhost/api/v1/me/image", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						data: "c3ludGhldGlj",
						contentType: "image/png",
						fileName: "synthetic.png",
					}),
				}),
			),
			POST(
				new Request("http://localhost/api/v1/me/sign-out-all", {
					method: "POST",
				}),
			),
			POST(
				new Request("http://localhost/api/v1/me/referrals", {
					method: "POST",
				}),
			),
			POST(
				new Request("http://localhost/api/v1/organizations", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: "Synthetic organization" }),
				}),
			),
			POST(
				new Request(
					"http://localhost/api/v1/organizations/org_synthetic/billing/checkout",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ interval: "yearly" }),
					},
				),
			),
			PUT(
				new Request(
					"http://localhost/api/v1/organizations/org_synthetic/storage/s3",
					{
						method: "PUT",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							provider: "aws",
							accessKeyId: "synthetic",
							secretAccessKey: "synthetic",
							endpoint: "https://s3.amazonaws.com",
							bucketName: "synthetic",
							region: "us-east-1",
						}),
					},
				),
			),
			POST(
				new Request(
					"http://localhost/api/v1/organizations/org_synthetic/storage/google-drive/connect",
					{ method: "POST" },
				),
			),
			POST(
				new Request(
					"http://localhost/api/v1/developer/apps/app_synthetic/credits/checkout",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ amountCents: 1_000 }),
					},
				),
			),
			POST(
				new Request(
					"http://localhost/api/v1/organizations/org_synthetic/imports/loom",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							loomUrl: "https://www.loom.com/share/synthetic",
						}),
					},
				),
			),
			GET(
				new Request(
					"http://localhost/api/v1/developer/apps/app_synthetic/videos",
				),
			),
			GET(
				new Request(
					"http://localhost/api/v1/developer/apps/app_synthetic/transactions",
				),
			),
			DELETE(
				new Request(
					"http://localhost/api/v1/developer/apps/app_synthetic/videos/video_synthetic",
					{ method: "DELETE" },
				),
			),
			PATCH(
				new Request(
					"http://localhost/api/v1/folders/folder_synthetic/public-page",
					{
						method: "PATCH",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ title: "Synthetic collection" }),
					},
				),
			),
			PUT(
				new Request("http://localhost/api/v1/spaces/space_synthetic/logo", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						data: "c3ludGhldGlj",
						contentType: "image/png",
						fileName: "synthetic.png",
					}),
				}),
			),
		];
		for (const request of requests) {
			const response = await request;
			const body = await response.json();
			expect(response.status).toBe(401);
			expect(body.code).toBe("AUTH_REQUIRED");
		}
	});
});
