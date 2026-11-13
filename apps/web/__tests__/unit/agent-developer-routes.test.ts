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
const MISSING_APP = "nosuchapp123456";
const APP = "app000000000001";
const NOT_FOUND_MESSAGE =
	"Developer app not found. Run `cap developers list` to see your apps.";
const FULL_SCOPES = [
	"caps:read",
	"billing:read",
	"billing:write",
	"developer:read",
	"developer:write",
	"developer:secrets",
];

type Handler = (request: Request) => Promise<Response>;

describe("developer routes of the agent API", () => {
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

	const base = `/developer/apps/${MISSING_APP}`;
	const everyAppRoute: [string, string, unknown?][] = [
		["GET", `${base}/context`],
		["GET", `${base}/videos`],
		["GET", `${base}/videos/video0000000001`],
		["GET", `${base}/transactions`],
		["GET", `${base}/transcripts`],
		["GET", `${base}/transcripts/transcript00001`],
		["PATCH", base, { name: "Renamed" }],
		["DELETE", base],
		["POST", `${base}/domains`, { domain: "https://example.com" }],
		["DELETE", `${base}/domains/domain000000001`],
		["POST", `${base}/keys/rotate`],
		["PATCH", `${base}/auto-top-up`, { enabled: false }],
		["POST", `${base}/credits/checkout`, { amountCents: 1000 }],
		["DELETE", `${base}/videos/video0000000001`],
		["POST", `${base}/videos`, { fileName: "a.mp4", contentLength: 10 }],
		["POST", `${base}/videos/video0000000001/complete`, {}],
		["POST", `${base}/transcripts`, { url: "https://example.com/a.mp3" }],
		["POST", `${base}/transcripts/transcript00001/start`],
		["DELETE", `${base}/transcripts/transcript00001`],
	];

	it.each(everyAppRoute)(
		"%s %s answers not found for an app the caller cannot see",
		async (method, path, body) => {
			const result = await call(method, path, body);
			expect(result.status).toBe(404);
			expect(result.body).toMatchObject({
				code: "NOT_FOUND",
				message: NOT_FOUND_MESSAGE,
				retryable: false,
			});
			expect(result.body.requestId).toEqual(expect.any(String));
		},
	);

	it("covers every developer route that takes an app id", async () => {
		const { readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const source = readFileSync(
			join(process.cwd(), "../../packages/web-domain/src/Agent.ts"),
			"utf8",
		);
		const declared = [
			...source.matchAll(
				/HttpApiEndpoint\.(get|post|patch|del|put)\(\s*"[A-Za-z]+",\s*"(\/developer\/apps\/:appId[^"]*)"/g,
			),
		].map(([, method, path]) => `${method} ${path}`);
		const tested = everyAppRoute.map(([method, path]) => {
			const verb = method === "DELETE" ? "del" : method.toLowerCase();
			const template = path
				.replace(MISSING_APP, ":appId")
				.replace("video0000000001", ":videoId")
				.replace("transcript00001", ":transcriptId")
				.replace("domain000000001", ":domainId");
			return `${verb} ${template}`;
		});
		expect(declared.length).toBeGreaterThan(0);
		expect([...tested].sort()).toEqual([...declared].sort());
	});

	it("says what to do when the developer scope is missing", async () => {
		state.scopes = ["caps:read"];
		for (const [method, path, scope] of [
			["GET", "/developer/apps", "developer:read"],
			["GET", `/developer/apps/${APP}/videos`, "developer:read"],
			["DELETE", `/developer/apps/${APP}`, "developer:write"],
		] as const) {
			const result = await call(method, path);
			expect(result.status).toBe(403);
			expect(result.body.code).toBe("FORBIDDEN");
			expect(result.body.message).toContain(
				`The ${scope} permission is required`,
			);
			expect(result.body.message).toContain("cap auth login --profile full");
			expect(result.body.hint).toContain("cap auth login --profile full");
			expect(result.body.hint).toContain("Settings, Account");
			expect(result.body.requiredScopes).toEqual([scope]);
		}
	});

	const videoRow = (overrides: Record<string, unknown> = {}) => ({
		id: "video0000000001",
		appId: APP,
		externalUserId: "user-7",
		name: "Demo",
		status: "ready",
		errorReason: null,
		playbackId: "playback-id-000000000001",
		duration: 12.5,
		width: 1280,
		height: 720,
		fps: 30,
		maxResolutionTier: "1080p",
		renditions: [
			{
				name: "720p",
				width: 1280,
				height: 720,
				bitrate: 2_000_000,
				bytes: 3_000_000,
				codecs: "avc1.64001f,mp4a.40.2",
			},
		],
		transcriptionStatus: null,
		processing: {
			hls: { state: "complete" },
			mp4: { state: "complete" },
			poster: { key: "developer/app/video/poster.jpg" },
		},
		s3Key: "developer/app/video/video",
		createdAt: new Date("2026-11-12T10:00:00.000Z"),
		updatedAt: new Date("2026-11-12T10:00:09.000Z"),
		...overrides,
	});

	it("returns one video with its status and links, and no storage key", async () => {
		state.apps = [{ id: APP }];
		state.videos = [videoRow()];
		const result = await call(
			"GET",
			`/developer/apps/${APP}/videos/video0000000001`,
		);
		expect(result.status).toBe(200);
		expect(result.body.video).toEqual({
			id: "video0000000001",
			appId: APP,
			externalUserId: "user-7",
			name: "Demo",
			status: "ready",
			errorReason: null,
			playbackId: "playback-id-000000000001",
			durationSeconds: 12.5,
			width: 1280,
			height: 720,
			fps: 30,
			maxResolutionTier: "1080p",
			renditions: videoRow().renditions,
			transcriptionStatus: null,
			hlsUrl:
				"http://localhost/api/developer/playback/playback-id-000000000001/master.m3u8",
			mp4Url:
				"http://localhost/api/developer/playback/playback-id-000000000001/video.mp4",
			posterUrl:
				"http://localhost/api/developer/playback/playback-id-000000000001/poster.jpg",
			shareUrl: "http://localhost/dev/playback-id-000000000001",
			embedUrl: "http://localhost/dev/playback-id-000000000001/embed",
			createdAt: "2026-11-12T10:00:00.000Z",
			updatedAt: "2026-11-12T10:00:09.000Z",
		});
		const serialized = JSON.stringify(result.body);
		expect(serialized).not.toContain("s3Key");
		expect(serialized).not.toContain("developer/app/video");
		expect(serialized).not.toContain("processing");
	});

	it("reports a video uploaded before encoding existed as ready", async () => {
		state.apps = [{ id: APP }];
		const legacy = {
			status: "uploading",
			playbackId: null,
			processing: null,
			renditions: null,
		};
		const path = `/developer/apps/${APP}/videos/video0000000001`;

		state.videos = [videoRow(legacy)];
		const finished = await call("GET", path);
		state.videos = [
			videoRow({ ...legacy, duration: null, width: null, height: null }),
		];
		const waiting = await call("GET", path);

		expect(finished.body.video.status).toBe("ready");
		expect(waiting.body.video.status).toBe("uploading");
	});

	it("restarts processing that never started when the video is read", async () => {
		state.apps = [{ id: APP }];
		const stalled = videoRow({
			status: "uploading",
			processing: null,
			updatedAt: new Date(Date.now() - 10 * 60_000),
		});
		const path = `/developer/apps/${APP}/videos/video0000000001`;
		state.redrive.mockReset();
		state.redrive.mockImplementation(async () => {
			state.videos = [{ ...stalled, status: "processing" }];
			return true;
		});

		state.videos = [stalled];
		const restarted = await call("GET", path);

		expect(state.redrive).toHaveBeenCalledExactlyOnceWith("video0000000001");
		expect(restarted.body.video.status).toBe("processing");

		state.redrive.mockReset();
		state.redrive.mockResolvedValue(false);
		state.videos = [stalled];
		const previewed = await call("GET", `${path}?restart=false`);

		expect(state.redrive).not.toHaveBeenCalled();
		expect(previewed.body.video.status).toBe("uploading");

		state.videos = [videoRow()];
		const ready = await call("GET", path);

		expect(state.redrive).not.toHaveBeenCalled();
		expect(ready.body.video.status).toBe("ready");
	});

	it("answers video not found inside an app the caller owns", async () => {
		state.apps = [{ id: APP }];
		const result = await call(
			"GET",
			`/developer/apps/${APP}/videos/video0000000001`,
		);
		expect(result.status).toBe(404);
		expect(result.body).toMatchObject({
			code: "NOT_FOUND",
			message: "Video not found in this developer app",
		});
	});

	it("lists videos with status and playback id and one capabilities block", async () => {
		state.apps = [{ id: APP }];
		state.videos = [
			videoRow(),
			videoRow({
				id: "video0000000002",
				status: "processing",
				processing: null,
				renditions: null,
			}),
			videoRow({
				id: "video0000000003",
				status: "errored",
				errorReason: "The file could not be decoded",
				processing: null,
				renditions: null,
			}),
		];
		const result = await call("GET", `/developer/apps/${APP}/videos`);
		expect(result.status).toBe(200);
		expect(
			result.body.videos.map((video: Record<string, unknown>) => [
				video.status,
				video.playbackId,
				video.hlsUrl !== null,
				video.shareUrl,
				video.errorReason,
			]),
		).toEqual([
			[
				"ready",
				"playback-id-000000000001",
				true,
				"http://localhost/dev/playback-id-000000000001",
				null,
			],
			[
				"processing",
				"playback-id-000000000001",
				false,
				"http://localhost/dev/playback-id-000000000001",
				null,
			],
			[
				"errored",
				"playback-id-000000000001",
				false,
				"http://localhost/dev/playback-id-000000000001",
				"The file could not be decoded",
			],
		]);
		expect(result.body.capabilities.uploadVideos.allowed).toBe(true);
		for (const video of result.body.videos) {
			expect(video).not.toHaveProperty("capabilities");
			expect(video).not.toHaveProperty("s3Key");
		}
		expect(JSON.stringify(result.body)).not.toContain("developer/app/video");
	});
});
