import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import type { S3ClientConfig } from "@aws-sdk/client-s3";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	isCap: "true" as string | undefined,
	nodeEnv: "production",
	s3Configs: [] as Array<Record<string, unknown>>,
	send: vi.fn(async () => ({})),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
	isRateLimited: vi.fn(async () => false),
	RATE_LIMIT_IDS: {
		AGENT_TOKEN_EXCHANGE: "rl_agent_token_exchange",
		AGENT_AUTHORIZATION: "rl_agent_authorization",
		AGENT_UNLOCK: "rl_agent_unlock",
		AGENT_LOOM_IMPORT: "rl_loom_import_per_user",
	},
}));

vi.mock("@cap/env", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@cap/env")>();
	return {
		...actual,
		buildEnv: new Proxy(actual.buildEnv, {
			get: (target, property) =>
				property === "NEXT_PUBLIC_IS_CAP"
					? state.isCap
					: Reflect.get(target, property),
		}),
		get NODE_ENV() {
			return state.nodeEnv;
		},
	};
});

vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
	class S3Client extends actual.S3Client {
		constructor(config: S3ClientConfig) {
			super(config);
			const credentials = config.credentials as
				| { accessKeyId?: string }
				| undefined;
			if (credentials?.accessKeyId === "AKIASYNTHETIC") {
				state.s3Configs.push(config as Record<string, unknown>);
				this.send = state.send as unknown as S3Client["send"];
			}
		}
	}
	return { ...actual, S3Client };
});

vi.mock("@/lib/agent-write", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/agent-write")>();
	return {
		...actual,
		runAgentExternalMutation: (input: {
			execute: (providerIdempotencyKey: string) => unknown;
		}) => input.execute("synthetic-provider-key"),
	};
});

const principalRow = {
	tokenId: "agk_synthetic",
	scopes: ["caps:read", "integrations:read", "integrations:write"],
	expiresAt: new Date(Date.now() + 60 * 60 * 1000),
	revokedAt: null,
	lastUsedAt: new Date(),
	id: "usr_synthetic",
	email: "owner@example.com",
	activeOrganizationId: "org_synthetic",
	role: "owner",
	hasProSeat: true,
	stripeSubscriptionStatus: "active",
	thirdPartyStripeSubscriptionId: null,
};

const query = (): unknown =>
	new Proxy(() => undefined, {
		get: (_, property) =>
			property === "then"
				? (resolve: (value: unknown) => void) => resolve([principalRow])
				: query,
		apply: query,
	});

vi.mock("@cap/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@cap/database")>();
	return { ...actual, db: query };
});

const token = `cap_cli_${"A".repeat(43)}`;

describe("agent API S3 endpoint policy", () => {
	let POST: typeof import("@/app/api/v1/[...route]/route").POST;
	let PUT: typeof import("@/app/api/v1/[...route]/route").PUT;
	let blockedS3EndpointMessage: string;

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
		POST = route.POST;
		PUT = route.PUT;
		({ blockedS3EndpointMessage } = await import("@/lib/s3-endpoint-policy"));
	});

	beforeEach(() => {
		state.isCap = "true";
		state.nodeEnv = "production";
		state.s3Configs.length = 0;
		state.send.mockClear();
	});

	const s3Request = (method: "POST" | "PUT", endpoint: string) =>
		new Request(
			`http://localhost/api/v1/organizations/org_synthetic/storage/s3${
				method === "POST" ? "/test" : ""
			}`,
			{
				method,
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
					"Idempotency-Key": "synthetic-idempotency-key",
					"X-Cap-Confirmation": "user",
				},
				body: JSON.stringify({
					provider: "aws",
					accessKeyId: "AKIASYNTHETIC",
					secretAccessKey: "synthetic-secret",
					endpoint,
					bucketName: "synthetic-bucket",
					region: "us-east-1",
				}),
			},
		);

	it.each([
		["PUT", "http://169.254.169.254"],
		["PUT", "http://localhost:9000"],
		["POST", "http://127.0.0.1:9000"],
		["POST", " http://[::1]:9000 "],
	] as const)(
		"rejects %s with private endpoint %s on Cap Cloud",
		async (method, endpoint) => {
			const handler = method === "POST" ? POST : PUT;
			const response = await handler(s3Request(method, endpoint));
			const body = await response.json();

			expect(response.status).toBe(400);
			expect(body).toMatchObject({
				code: "INVALID_REQUEST",
				message: blockedS3EndpointMessage,
			});
			expect(state.s3Configs).toHaveLength(0);
			expect(state.send).not.toHaveBeenCalled();
		},
	);

	it("tests public endpoints through public-only agents on Cap Cloud", async () => {
		const response = await POST(s3Request("POST", "https://8.8.8.8"));

		expect(response.status).toBe(200);
		expect(state.s3Configs).toHaveLength(1);
		const requestHandler = state.s3Configs[0]?.requestHandler as {
			httpAgent?: unknown;
			httpsAgent?: unknown;
		};
		expect(requestHandler.httpAgent).toBeInstanceOf(HttpAgent);
		expect(requestHandler.httpsAgent).toBeInstanceOf(HttpsAgent);
		expect(state.send).toHaveBeenCalledTimes(1);
	});

	it("allows local endpoints on self-hosted deployments", async () => {
		state.isCap = undefined;
		const response = await POST(s3Request("POST", "http://localhost:9000"));

		expect(response.status).toBe(200);
		expect(state.s3Configs).toHaveLength(1);
		expect(state.s3Configs[0]).toMatchObject({
			endpoint: "http://localhost:9000",
		});
		expect(state.s3Configs[0]?.requestHandler).toBeUndefined();
		expect(state.send).toHaveBeenCalledTimes(1);
	});
});
