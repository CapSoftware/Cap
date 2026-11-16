import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/rate-limit", () => ({
	isRateLimited: async () => false,
	RATE_LIMIT_IDS: {
		AGENT_TOKEN_EXCHANGE: "rl_agent_token_exchange",
		AGENT_AUTHORIZATION: "rl_agent_authorization",
		AGENT_UNLOCK: "rl_agent_unlock",
		AGENT_LOOM_IMPORT: "rl_loom_import_per_user",
	},
}));

const state = vi.hoisted(() => ({
	scopes: [] as string[],
	apps: [] as { id: string }[],
	videos: [] as Record<string, unknown>[],
	transactions: [] as Record<string, unknown>[],
	idempotency: null as Record<string, unknown> | null,
	tables: {} as Record<string, unknown>,
	redrive: vi.fn(async (_videoId: string) => false),
	createFromUrl: vi.fn(),
	startUpload: vi.fn(),
}));

vi.mock("@/lib/developer-transcript-store", async (original) => ({
	...(await original<typeof import("@/lib/developer-transcript-store")>()),
	createTranscriptFromUrl: state.createFromUrl,
	startTranscriptUpload: state.startUpload,
}));

vi.mock("@/lib/developer-video-start", async (original) => ({
	...(await original<typeof import("@/lib/developer-video-start")>()),
	redriveDeveloperVideoProcessing: state.redrive,
}));

vi.mock("@cap/database", () => {
	const rowsFor = (table: unknown) => {
		const { tables } = state;
		if (table === tables.agentApiKeys) {
			return [
				{
					tokenId: "token-1",
					scopes: state.scopes,
					expiresAt: new Date(Date.now() + 60_000),
					revokedAt: null,
					lastUsedAt: new Date(),
					id: "user-1",
					email: "owner@example.com",
					activeOrganizationId: "org-1",
				},
			];
		}
		if (table === tables.developerApps) return state.apps;
		if (table === tables.developerVideos) return state.videos;
		if (table === tables.developerCreditTransactions) {
			return state.transactions;
		}
		if (table === tables.agentApiIdempotency) {
			return state.idempotency ? [state.idempotency] : [];
		}
		return [];
	};
	const reader = () => {
		let table: unknown;
		const chain = Object.assign(
			Promise.resolve().then(() => rowsFor(table)),
			{
				from: (next: unknown) => {
					table = next;
					return chain;
				},
				innerJoin: () => chain,
				leftJoin: () => chain,
				where: () => chain,
				orderBy: () => chain,
				limit: () => chain,
				for: () => chain,
				groupBy: () => chain,
			},
		);
		return chain;
	};
	const writer = (table: unknown) => {
		const chain = Object.assign(Promise.resolve([{ affectedRows: 1 }]), {
			set: () => chain,
			where: () => chain,
			onDuplicateKeyUpdate: () => chain,
			values: (values: Record<string, unknown>) => {
				if (table === state.tables.agentApiIdempotency) {
					state.idempotency = { ...values, state: "pending", response: null };
				}
				return chain;
			},
		});
		return chain;
	};
	const client = {
		select: reader,
		insert: writer,
		update: writer,
		delete: writer,
		transaction: async (run: (tx: unknown) => unknown) => run(client),
	};
	return { db: () => client };
});

const TOKEN = `cap_cli_${"a".repeat(43)}`;
const APP = "app000000000001";
const FULL_SCOPES = [
	"caps:read",
	"billing:read",
	"billing:write",
	"developer:read",
	"developer:write",
	"developer:secrets",
];

type Handler = (request: Request) => Promise<Response>;

describe("the transcript ceiling on the agent API", () => {
	let handlers: Record<string, Handler>;

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
		const schema = await import("@cap/database/schema");
		state.tables = {
			agentApiKeys: schema.agentApiKeys,
			developerApps: schema.developerApps,
			developerVideos: schema.developerVideos,
			developerCreditTransactions: schema.developerCreditTransactions,
			agentApiIdempotency: schema.agentApiIdempotency,
		};
		const route = await import("@/app/api/v1/[...route]/route");
		handlers = {
			GET: route.GET,
			POST: route.POST,
			PATCH: route.PATCH,
			DELETE: route.DELETE,
		};
	});

	beforeEach(() => {
		state.scopes = FULL_SCOPES;
		state.apps = [];
		state.videos = [];
		state.transactions = [];
		state.idempotency = null;
	});

	const call = async (method: string, path: string, body?: unknown) => {
		const handler = handlers[method];
		if (!handler) throw new Error(`No handler for ${method}`);
		const response = await handler(
			new Request(`http://localhost/api/v1${path}`, {
				method,
				headers: {
					Authorization: `Bearer ${TOKEN}`,
					"Content-Type": "application/json",
					"Idempotency-Key": "idempotency-key-0001",
					"X-Cap-Confirmation": "user",
				},
				body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
			}),
		);
		return { status: response.status, body: await response.json() };
	};

	const AT_CEILING = {
		ok: false as const,
		status: 429 as const,
		code: "too_many_transcripts",
		message: "This app already has 20 transcripts queued or processing",
		hint: "Wait for one to finish, then send the request again.",
	};

	it.each([
		[
			"creating from a URL",
			`/developer/apps/${APP}/transcripts`,
			{ url: "https://example.com/a.mp3" },
		],
		[
			"starting an upload",
			`/developer/apps/${APP}/transcripts/transcript00001/start`,
			undefined,
		],
	])(
		"answers 429 that says to wait when %s at the ceiling",
		async (_label, path, body) => {
			state.apps = [{ id: APP }];
			state.createFromUrl.mockResolvedValue(AT_CEILING);
			state.startUpload.mockResolvedValue(AT_CEILING);

			const result = await call("POST", path, body);

			expect(result.status).toBe(429);
			expect(result.body).toMatchObject({
				code: "RATE_LIMITED",
				message:
					"This app already has 20 transcripts queued or processing. Wait for one to finish, then retry.",
				retryable: true,
				retryAfterMs: 15_000,
			});
		},
	);
});
