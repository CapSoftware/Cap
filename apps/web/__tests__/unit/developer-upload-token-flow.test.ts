import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = await vi.hoisted(() => import("./developer-upload-harness"));

vi.mock("@cap/database", () => harness.databaseMock());
vi.mock("@cap/database/helpers", () => ({
	nanoId: () => `video-${++harness.state.nextVideo}`,
	nanoIdLength: 15,
}));
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@cap/database/auth/domain-utils", () => ({
	isBlockedAccountEmail: () => false,
}));
vi.mock("@cap/database/auth/request-site", () => ({
	isCrossSiteCookieWrite: () => false,
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: harness.ORIGIN },
	serverEnv: () => ({
		WEB_URL: harness.ORIGIN,
		NEXTAUTH_SECRET: "unit-test-signing-secret",
	}),
}));
vi.mock("@cap/web-backend", () => harness.storageMock());
vi.mock("@/lib/server", () => harness.serverMock());
vi.mock("@/lib/developer-key-hash", () => ({
	hashKey: async (key: string) => `hash:${key}`,
}));
vi.mock("@/lib/infra-standing", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/infra-standing")>()),
	getInfraUploadAdmission: harness.state.admission,
}));
vi.mock("@/lib/developer-video-start", () => ({
	claimDeveloperVideoUpload: harness.state.claim,
	releaseDeveloperVideoUpload: harness.state.release,
	startDeveloperVideoProcessing: harness.state.startProcessing,
	redriveDeveloperVideoProcessing: vi.fn(),
}));
vi.mock("@/lib/developer-transcript-store", () => ({
	isTranscriptIdempotencyKey: () => true,
}));

const sdk = await import("@/app/api/developer/sdk/v1/[...route]/route");
const rest = await import("@/app/api/developer/v1/[...route]/route");
const { createDeveloperUploadToken } = await import(
	"@/lib/developer-upload-token"
);

const { state, post, secretKey, videoWrites, storageCalls, UPLOAD_ROUTES } =
	harness;

const NOW = Date.parse("2026-11-12T10:00:00Z");
const PAGE = "https://app.example.com";

type Created = {
	id: string;
	videoId: string;
	token: string;
	expiresAt: string;
	corsOrigin: string | null;
	status: string;
	uploadUrl: string;
	playbackId: string;
	shareUrl: string;
	embedUrl: string;
};

const createUpload = (body: Record<string, unknown> = {}, appId = "app1") =>
	post(rest, "/api/developer/v1/uploads", secretKey(appId), body);

async function created(body: Record<string, unknown> = {}, appId = "app1") {
	const response = await createUpload(body, appId);
	expect(response.status).toBe(200);
	return (await response.json()).data as Created;
}

const upload = (
	route: string,
	credential: string | null,
	body: Record<string, unknown> = {},
	headers: Record<string, string> = {},
) =>
	post(
		sdk,
		`/api/developer/sdk/v1/upload/multipart/${route}`,
		credential,
		body,
		headers,
	);

const inserts = () =>
	videoWrites().filter(([query]) => String(query).startsWith("insert"));
const durationWrites = () =>
	videoWrites().filter(([query]) =>
		/^update `developer_videos` set .*`duration` = \?/.test(String(query)),
	);

async function refusedEverywhere(
	credential: string | null,
	status: number,
	code: string,
	headers: Record<string, string> = {},
	extraBody: Record<string, unknown> = {},
) {
	for (const [route, body] of UPLOAD_ROUTES) {
		const response = await upload(
			route,
			credential,
			{ ...body, ...extraBody },
			headers,
		);
		expect([route, response.status]).toEqual([route, status]);
		expect(await response.json()).toMatchObject({ code });
	}
	expect(storageCalls()).toBe(0);
	expect(durationWrites()).toHaveLength(0);
	expect(state.claim).not.toHaveBeenCalled();
	expect(state.startProcessing).not.toHaveBeenCalled();
}

const [, , [, completeBody]] = UPLOAD_ROUTES;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	harness.resetUploadHarness();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("creating an upload with the secret key", () => {
	it("creates the video and returns a token bound to it", async () => {
		const data = await created({
			name: "Demo",
			userId: "user_42",
			metadata: { plan: "pro" },
			maxResolutionTier: "1440p",
		});

		expect(Object.keys(data).sort()).toEqual([
			"corsOrigin",
			"embedUrl",
			"expiresAt",
			"id",
			"playbackId",
			"shareUrl",
			"status",
			"token",
			"uploadUrl",
			"videoId",
		]);
		expect(data).toMatchObject({
			id: "video-1",
			videoId: "video-1",
			corsOrigin: null,
			status: "uploading",
			expiresAt: new Date(NOW + 3_600_000).toISOString(),
			uploadUrl: `${harness.ORIGIN}/api/developer/sdk/v1/upload/multipart`,
		});
		expect(data.token).toMatch(/^cut_[\w-]+\.[\w-]{43}$/);
		expect(inserts()).toHaveLength(1);
		const [, params] = inserts()[0] ?? [];
		expect(params).toEqual(
			expect.arrayContaining([
				"video-1",
				"app1",
				"user_42",
				"Demo",
				"developer/app1/video-1/video",
				"1440p",
				data.playbackId,
			]),
		);
		expect(state.admission).toHaveBeenCalledExactlyOnceWith("app1");
	});

	it("refuses with 402 and makes neither a video nor a token when the app cannot take an upload", async () => {
		state.admission.mockResolvedValue({
			allowed: false,
			reason: "insufficient_credits",
			standing: { state: "active", pausesAt: null },
			balanceMicroCredits: 0,
			requiredMicroCredits: 19_834,
			shortfallMicroCredits: 19_834,
			message: "This app has no credit.",
		});

		const response = await createUpload({ name: "Demo" });

		expect(response.status).toBe(402);
		const body = await response.json();
		expect(body).toMatchObject({ code: "insufficient_credits" });
		expect(JSON.stringify(body)).not.toContain("cut_");
		expect(inserts()).toHaveLength(0);
	});

	it.each([
		["a public key", "cpk_app1_page"],
		["an upload token", "cut_abc.def"],
		["no key", null],
	])("refuses %s and inserts nothing", async (_label, credential) => {
		const response = await post(
			rest,
			"/api/developer/v1/uploads",
			credential,
			{},
		);

		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ code: "invalid_secret_key" });
		expect(inserts()).toHaveLength(0);
	});

	it.each([
		[60, 60],
		[86_400, 86_400],
		[undefined, 3_600],
	])("lets the token live for timeoutSeconds %s", async (sent, seconds) => {
		const data = await created(
			sent === undefined ? {} : { timeoutSeconds: sent },
		);

		expect(data.expiresAt).toBe(new Date(NOW + seconds * 1000).toISOString());
	});

	it.each([59, 86_401, 0, -1, 90.5, "3600"])(
		"refuses timeoutSeconds %s",
		async (timeoutSeconds) => {
			const response = await createUpload({ timeoutSeconds });

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ code: "invalid_request" });
			expect(inserts()).toHaveLength(0);
		},
	);

	it.each([
		"https://app.example.com/",
		"https://app.example.com/upload",
		"app.example.com",
		"https://App.Example.com",
		"https://*.example.com",
		"*",
		"ftp://app.example.com",
		"https://app.example.com:443",
		"",
	])(
		"refuses corsOrigin %s, which is not an exact origin",
		async (corsOrigin) => {
			const response = await createUpload({ corsOrigin });

			expect(response.status).toBe(400);
			const body = await response.json();
			expect(body.code).toBe("invalid_request");
			expect(body.issues[0].path).toEqual(["corsOrigin"]);
			expect(inserts()).toHaveLength(0);
		},
	);

	it.each([
		"https://app.example.com",
		"https://app.example.com:8443",
		"http://localhost:3000",
	])("accepts corsOrigin %s", async (corsOrigin) => {
		const data = await created({ corsOrigin });

		expect(data.corsOrigin).toBe(corsOrigin);
	});

	it("is rate limited like the other secret key routes", async () => {
		const key = secretKey("app1");
		const send = () => post(rest, "/api/developer/v1/uploads", key, {});

		const first = await send();
		expect(first.headers.get("X-RateLimit-Limit")).toBe("60");
		expect(first.headers.get("X-RateLimit-Remaining")).toBe("59");
		for (let request = 2; request <= 60; request++) await send();
		const limited = await send();

		expect(limited.status).toBe(429);
		expect(await limited.json()).toMatchObject({ code: "rate_limited" });
		expect(inserts()).toHaveLength(60);
	});
});

describe("uploading with the token", () => {
	it("runs initiate, presign and complete, records the video once and starts processing once", async () => {
		const { token, videoId } = await created();
		const s3Key = `developer/app1/${videoId}/video`;

		const initiated = await upload("initiate", token, {
			contentType: "video/webm",
		});
		expect(initiated.status).toBe(200);
		expect(await initiated.json()).toEqual({ uploadId: "upload-1" });
		expect(state.create).toHaveBeenCalledExactlyOnceWith(
			s3Key,
			expect.objectContaining({ ContentType: "video/webm" }),
		);

		const presigned = await upload("presign-part", token, {
			uploadId: "upload-1",
			partNumber: 1,
		});
		expect(presigned.status).toBe(200);
		expect(await presigned.json()).toEqual({
			presignedUrl: "https://storage.test/part",
		});
		expect(state.presign).toHaveBeenCalledExactlyOnceWith(s3Key, "upload-1", 1);

		const completed = await upload("complete", token, completeBody);
		expect(completed.status).toBe(200);
		expect(await completed.json()).toEqual({ success: true });

		expect(state.complete).toHaveBeenCalledTimes(1);
		expect(durationWrites()).toHaveLength(1);
		expect(state.claim).toHaveBeenCalledExactlyOnceWith(videoId);
		expect(state.startProcessing).toHaveBeenCalledExactlyOnceWith(videoId, {
			action: "start",
			encodeId: "encode-1",
		});
		expect(inserts()).toHaveLength(1);
	});

	it("accepts the token's own videoId in the body", async () => {
		const { token, videoId } = await created();

		const response = await upload("initiate", token, { videoId });

		expect(response.status).toBe(200);
	});

	it("stops working once the upload completes", async () => {
		const { token } = await created();
		await upload("initiate", token);
		await upload("complete", token, completeBody);
		const storageBefore = storageCalls();

		for (const [route, body] of UPLOAD_ROUTES) {
			if (route === "complete") continue;
			const response = await upload(route, token, body);
			expect([route, response.status]).toEqual([route, 409]);
			expect(await response.json()).toMatchObject({
				code: "upload_already_completed",
			});
		}
		const repeated = await upload("complete", token, completeBody);

		expect(repeated.status).toBe(200);
		expect(await repeated.json()).toEqual({ success: true });
		expect(storageCalls()).toBe(storageBefore);
		expect(durationWrites()).toHaveLength(1);
		expect(state.claim).toHaveBeenCalledTimes(1);
		expect(state.startProcessing).toHaveBeenCalledTimes(1);
	});

	it("stops working once the video is deleted", async () => {
		const { token, videoId } = await created();
		const video = state.videos.get(videoId);
		if (video) video.deletedAt = "2026-11-12 10:00:01";

		await refusedEverywhere(token, 404, "video_not_found");
	});

	it("looks the video up by its id and app, in an app that is not deleted", async () => {
		const { token, videoId } = await created();
		state.query.mockClear();

		await upload("initiate", token);

		const [query, params] = state.query.mock.calls[0] ?? [];
		expect(String(query)).toBe(
			"select `developer_videos`.`duration`, `developer_videos`.`deletedAt` from `developer_videos` inner join `developer_apps` on (`developer_videos`.`appId` = `developer_apps`.`id` and `developer_apps`.`deletedAt` is null) where (`developer_videos`.`id` = ? and `developer_videos`.`appId` = ?) limit ?",
		);
		expect(params).toEqual([videoId, "app1", 1]);
	});

	it("stops working once the app is deleted", async () => {
		const { token } = await created();
		state.apps.delete("app1");

		await refusedEverywhere(token, 404, "video_not_found");
	});

	it("works until it expires and not after", async () => {
		const { token } = await created({ timeoutSeconds: 60 });

		vi.setSystemTime(NOW + 59_999);
		expect((await upload("initiate", token)).status).toBe(200);
		state.create.mockClear();

		vi.setSystemTime(NOW + 60_000);
		await refusedEverywhere(token, 401, "upload_token_expired");
	});
});

describe("a token for one video", () => {
	it("cannot act on another video of the same app", async () => {
		const first = await created();
		const second = await created();

		await refusedEverywhere(
			first.token,
			403,
			"video_mismatch",
			{},
			{ videoId: second.videoId },
		);
	});

	it("cannot act on a video of another app", async () => {
		const mine = await created({}, "app1");
		const theirs = await created({}, "app2");

		await refusedEverywhere(
			mine.token,
			403,
			"video_mismatch",
			{},
			{ videoId: theirs.videoId },
		);
	});

	it("is refused when it names an app that does not own the video", async () => {
		const theirs = await created({}, "app2");
		const crossed = createDeveloperUploadToken({
			appId: "app1",
			videoId: theirs.videoId,
			expiresAt: NOW + 3_600_000,
			corsOrigin: null,
		});

		await refusedEverywhere(crossed, 404, "video_not_found");
	});

	it("is refused when its payload is rewritten to name another video", async () => {
		const mine = await created({}, "app1");
		const theirs = await created({}, "app2");
		const [, signature] = mine.token.split(".");
		const payload = Buffer.from(
			JSON.stringify({
				v: 1,
				app: "app2",
				video: theirs.videoId,
				exp: NOW + 3_600_000,
				origin: null,
			}),
		).toString("base64url");

		await refusedEverywhere(
			`cut_${payload}.${signature}`,
			401,
			"invalid_upload_token",
		);
	});

	it.each([
		["a changed signature", (token: string) => `${token.slice(0, -2)}AA`],
		["a missing signature", (token: string) => token.split(".")[0] ?? ""],
		["a changed payload", (token: string) => `cut_x${token.slice(4)}`],
	])("is refused with %s", async (_label, alter) => {
		const { token } = await created();
		const altered = alter(token);
		expect(altered).not.toBe(token);

		await refusedEverywhere(altered, 401, "invalid_upload_token");
	});
});

describe("the origin an upload token allows", () => {
	it("refuses another origin and a missing one when corsOrigin is set", async () => {
		const { token } = await created({ corsOrigin: PAGE });

		await refusedEverywhere(token, 403, "origin_not_allowed", {
			Origin: "https://attacker.example",
		});
		await refusedEverywhere(token, 403, "origin_not_allowed");
	});

	it("accepts the origin it was made for", async () => {
		const { token } = await created({ corsOrigin: PAGE });

		const response = await upload("initiate", token, {}, { Origin: PAGE });

		expect(response.status).toBe(200);
	});

	it.each([
		["any origin", { Origin: "https://anywhere.example" }],
		["no origin", {}],
	])("accepts %s when corsOrigin is not set", async (_label, headers) => {
		const { token } = await created();

		const response = await upload("initiate", token, {}, headers);

		expect(response.status).toBe(200);
	});

	it("answers the browser's preflight for any origin without a credential", async () => {
		const response = (await sdk.OPTIONS(
			new Request(
				`${harness.ORIGIN}/api/developer/sdk/v1/upload/multipart/initiate`,
				{
					method: "OPTIONS",
					headers: {
						Origin: PAGE,
						"Access-Control-Request-Method": "POST",
						"Access-Control-Request-Headers": "authorization,content-type",
					},
				},
			),
		)) as Response;

		expect(response.status).toBe(204);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
		expect(response.headers.get("Access-Control-Allow-Headers")).toContain(
			"Authorization",
		);
	});
});

describe("credentials that are not upload tokens", () => {
	it("refuses a secret key on the upload routes", async () => {
		await refusedEverywhere(secretKey("app1"), 401, "invalid_upload_token");
	});

	it("refuses a request with no credential", async () => {
		await refusedEverywhere(null, 401, "invalid_upload_token");
	});

	it("no longer serves the old create endpoint", async () => {
		const response = await post(
			sdk,
			"/api/developer/sdk/v1/videos/create",
			secretKey("app1"),
			{ name: "Demo" },
		);

		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ code: "not_found" });
		expect(inserts()).toHaveLength(0);
	});
});
