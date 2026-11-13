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
	maxBytes: number | null;
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
			"maxBytes",
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

	const storedUserId = () => {
		const [query, params] = inserts()[0] ?? [];
		const text = String(query);
		const columns = [
			...(
				text.slice(text.indexOf("("), text.indexOf(") values")) ?? ""
			).matchAll(/`(\w+)`/g),
		].map((match) => match[1]);
		const values = text
			.slice(
				text.indexOf("values (") + "values (".length,
				text.lastIndexOf(")"),
			)
			.split(",")
			.map((value) => value.trim());
		const index = columns.indexOf("externalUserId");
		if (index < 0 || values.length !== columns.length) {
			throw new Error("Could not read the inserted columns");
		}
		if (values[index] !== "?") return values[index];
		const bound = values
			.slice(0, index)
			.filter((value) => value === "?").length;
		return (params as unknown[])[bound];
	};

	it("stores a plain user id as sent", async () => {
		await created({ name: "Demo", userId: "user_42" });

		expect(storedUserId()).toBe("user_42");
	});

	it.each([
		["  user_42  ", "user_42"],
		["user_42\n", "user_42"],
	])("stores the user id %j without its padding", async (sent, stored) => {
		await created({ name: "Demo", userId: sent });

		expect(storedUserId()).toBe(stored);
	});

	it.each(["", "   "])("stores no user id for %j", async (sent) => {
		await created({ name: "Demo", userId: sent });

		expect(storedUserId()).toBeNull();
	});

	it("stores no user id when none is sent", async () => {
		await created({ name: "Demo" });

		expect(storedUserId()).toBeNull();
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

const renew = (
	videoId: string,
	body: Record<string, unknown> = {},
	credential: string | null = secretKey("app1"),
) => post(rest, `/api/developer/v1/uploads/${videoId}/token`, credential, body);

async function renewed(videoId: string, body: Record<string, unknown> = {}) {
	const response = await renew(videoId, body);
	expect(response.status).toBe(200);
	return (await response.json()).data as Omit<
		Created,
		"playbackId" | "shareUrl" | "embedUrl"
	>;
}

const keyOf = (videoId: string, appId = "app1") =>
	`developer/${appId}/${videoId}/video`;

describe("renewing the token of an open upload", () => {
	it("finishes the same upload after the first token expired", async () => {
		const first = await created({ timeoutSeconds: 60 });
		const s3Key = keyOf(first.videoId);
		const initiated = await upload("initiate", first.token);
		expect(await initiated.json()).toEqual({ uploadId: "upload-1" });
		state.listUploads.mockReturnValue({
			Uploads: [{ Key: s3Key, UploadId: "upload-1", Initiated: new Date(NOW) }],
		});
		await upload("presign-part", first.token, {
			uploadId: "upload-1",
			partNumber: 1,
		});

		vi.setSystemTime(NOW + 61_000);
		const expired = await upload("complete", first.token, completeBody);
		expect(expired.status).toBe(401);
		expect(await expired.json()).toMatchObject({
			code: "upload_token_expired",
			hint: expect.stringContaining(
				"/api/developer/v1/uploads/{videoId}/token",
			),
		});
		expect(durationWrites()).toHaveLength(0);

		const next = await renewed(first.videoId);
		expect(next).toEqual({
			id: first.videoId,
			videoId: first.videoId,
			token: expect.stringMatching(/^cut_[\w-]+\.[\w-]{43}$/),
			expiresAt: new Date(NOW + 61_000 + 3_600_000).toISOString(),
			corsOrigin: null,
			maxBytes: null,
			status: "uploading",
			uploadUrl: `${harness.ORIGIN}/api/developer/sdk/v1/upload/multipart`,
		});
		expect(next.token).not.toBe(first.token);
		expect(inserts()).toHaveLength(1);

		const resumed = await upload("initiate", next.token);
		expect(resumed.status).toBe(200);
		expect(await resumed.json()).toEqual({ uploadId: "upload-1" });
		expect(state.create).toHaveBeenCalledTimes(1);

		const completed = await upload("complete", next.token, completeBody);
		expect(completed.status).toBe(200);
		expect(await completed.json()).toEqual({ success: true });
		expect(state.complete).toHaveBeenCalledExactlyOnceWith(
			s3Key,
			"upload-1",
			expect.anything(),
		);
		expect(durationWrites()).toHaveLength(1);
		expect(state.startProcessing).toHaveBeenCalledExactlyOnceWith(
			first.videoId,
			{ action: "start", encodeId: "encode-1" },
		);
		expect((await upload("initiate", first.token)).status).toBe(401);
	});

	it("takes the same corsOrigin, timeoutSeconds and maxBytes options as create", async () => {
		const first = await created();

		const next = await renewed(first.videoId, {
			corsOrigin: PAGE,
			timeoutSeconds: 120,
			maxBytes: 500_000_000,
		});

		expect(next).toMatchObject({
			corsOrigin: PAGE,
			maxBytes: 500_000_000,
			expiresAt: new Date(NOW + 120_000).toISOString(),
		});
		expect((await upload("initiate", next.token)).status).toBe(403);
		expect(
			(await upload("initiate", next.token, {}, { Origin: PAGE })).status,
		).toBe(200);
		vi.setSystemTime(NOW + 120_000);
		expect(
			(await upload("initiate", next.token, {}, { Origin: PAGE })).status,
		).toBe(401);
	});

	it("leaves the earlier token working until its own expiry", async () => {
		const first = await created({ timeoutSeconds: 600 });
		await renewed(first.videoId);

		expect((await upload("initiate", first.token)).status).toBe(200);
	});

	it("refuses a completed upload", async () => {
		const first = await created();
		await upload("initiate", first.token);
		await upload("complete", first.token, completeBody);

		const response = await renew(first.videoId);

		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body).toMatchObject({ code: "upload_already_completed" });
		expect(JSON.stringify(body)).not.toContain("cut_");
	});

	it("refuses a deleted video", async () => {
		const first = await created();
		const video = state.videos.get(first.videoId);
		if (video) video.deletedAt = "2026-11-12 10:00:01";

		const response = await renew(first.videoId);

		expect(response.status).toBe(404);
		const body = await response.json();
		expect(body).toMatchObject({ code: "video_not_found" });
		expect(JSON.stringify(body)).not.toContain("cut_");
	});

	it("refuses a video of another app the same way as one that does not exist", async () => {
		const theirs = await created({}, "app2");

		const foreign = await renew(theirs.videoId, {}, secretKey("app1"));
		const missing = await renew("no-such-video");

		expect(foreign.status).toBe(404);
		expect(missing.status).toBe(404);
		const body = await foreign.json();
		expect(body).toEqual(await missing.json());
		expect(body).toMatchObject({ code: "video_not_found" });
		expect(JSON.stringify(body)).not.toContain("cut_");
	});

	it.each([
		["a public key", "cpk_app1_page"],
		["no key", null],
	])("refuses %s", async (_label, credential) => {
		const first = await created();

		const response = await renew(first.videoId, {}, credential);

		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ code: "invalid_secret_key" });
	});

	it("cannot be renewed with the upload token itself", async () => {
		const first = await created();

		const response = await renew(first.videoId, {}, first.token);

		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ code: "invalid_secret_key" });
	});

	it.each([
		[{ timeoutSeconds: 59 }, "timeoutSeconds"],
		[{ timeoutSeconds: 86_401 }, "timeoutSeconds"],
		[{ corsOrigin: "https://app.example.com/" }, "corsOrigin"],
		[{ maxBytes: 0 }, "maxBytes"],
	])("refuses the option %o", async (body, field) => {
		const first = await created();

		const response = await renew(first.videoId, body);

		expect(response.status).toBe(400);
		const refusal = await response.json();
		expect(refusal.code).toBe("invalid_request");
		expect(refusal.issues[0].path).toEqual([field]);
	});

	it("refuses a field it does not know and names it", async () => {
		const first = await created();

		const response = await renew(first.videoId, { name: "Renamed" });

		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.code).toBe("invalid_request");
		expect(body.error).toContain('"name"');
		expect(body.hint).toBe(
			"This request accepts corsOrigin, timeoutSeconds, maxBytes. Field names are case-sensitive.",
		);
	});
});

describe("signing several parts in one request", () => {
	const numbered = (count: number) =>
		Array.from({ length: count }, (_, index) => index + 1);

	beforeEach(() => {
		state.presign.mockImplementation(
			(_key: string, _uploadId: string, part: number) =>
				`https://storage.test/part-${part}`,
		);
	});

	it("returns one URL per part number", async () => {
		const { token, videoId } = await created();

		const response = await upload("presign-part", token, {
			uploadId: "upload-1",
			partNumbers: [1, 2, 3],
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			parts: [1, 2, 3].map((partNumber) => ({
				partNumber,
				presignedUrl: `https://storage.test/part-${partNumber}`,
			})),
		});
		expect(state.presign.mock.calls).toEqual(
			[1, 2, 3].map((part) => [keyOf(videoId), "upload-1", part]),
		);
	});

	it("still answers the single partNumber form with one presignedUrl", async () => {
		const { token } = await created();

		const response = await upload("presign-part", token, {
			uploadId: "upload-1",
			partNumber: 7,
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			presignedUrl: "https://storage.test/part-7",
		});
	});

	it("signs up to 50 parts in a request", async () => {
		const { token } = await created();

		const response = await upload("presign-part", token, {
			uploadId: "upload-1",
			partNumbers: numbered(50),
		});

		expect(response.status).toBe(200);
		expect((await response.json()).parts).toHaveLength(50);
		expect(state.presign).toHaveBeenCalledTimes(50);
	});

	it.each([
		["51 parts", numbered(51)],
		["no parts", []],
	])("refuses %s and signs nothing", async (_label, partNumbers) => {
		const { token } = await created();

		const response = await upload("presign-part", token, {
			uploadId: "upload-1",
			partNumbers,
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			code: "invalid_part_count",
			error: "Ask for 1 to 50 parts at a time",
		});
		expect(state.presign).not.toHaveBeenCalled();
	});

	it.each([
		["both forms", { partNumber: 1, partNumbers: [1, 2] }],
		["neither form", {}],
		["a part number of 0", { partNumbers: [1, 0] }],
		["a part number over 10000", { partNumbers: [10_001] }],
		["a fractional part number", { partNumbers: [1.5] }],
		["a part number sent as text", { partNumbers: ["1"] }],
		["a list that is not an array", { partNumbers: 3 }],
	])("refuses %s and signs nothing", async (_label, body) => {
		const { token } = await created();

		const response = await upload("presign-part", token, {
			uploadId: "upload-1",
			...body,
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ code: "invalid_request" });
		expect(state.presign).not.toHaveBeenCalled();
	});
});

describe("a size cap on an upload token", () => {
	const STORED = 1_048_576;

	it("returns the cap with the upload, and null when none was set", async () => {
		expect((await created({ maxBytes: 250_000_000 })).maxBytes).toBe(
			250_000_000,
		);
		expect((await created()).maxBytes).toBeNull();
		expect((await created({ maxBytes: 36_000_000_000 })).maxBytes).toBe(
			36_000_000_000,
		);
	});

	it.each([0, -1, 1.5, "100", 36_000_000_001])(
		"refuses maxBytes %s",
		async (maxBytes) => {
			const response = await createUpload({ maxBytes });

			expect(response.status).toBe(400);
			const body = await response.json();
			expect(body.code).toBe("invalid_request");
			expect(body.issues[0].path).toEqual(["maxBytes"]);
			expect(inserts()).toHaveLength(0);
		},
	);

	it("refuses complete when the stored parts exceed the cap, whatever size the request declares", async () => {
		const { token, videoId } = await created({ maxBytes: STORED - 1 });
		await upload("initiate", token);

		const response = await upload("complete", token, {
			...completeBody,
			parts: [{ partNumber: 1, etag: "etag-1", size: 1 }],
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			code: "file_too_large",
			error: `The file is larger than the ${STORED - 1} byte limit set for this upload`,
			hint: expect.stringContaining("larger maxBytes"),
		});
		expect(state.abort).toHaveBeenCalledExactlyOnceWith(
			keyOf(videoId),
			"upload-1",
		);
		expect(state.complete).not.toHaveBeenCalled();
		expect(durationWrites()).toHaveLength(0);
		expect(state.claim).not.toHaveBeenCalled();
		expect(state.startProcessing).not.toHaveBeenCalled();
	});

	it("completes an upload whose stored parts are exactly the cap", async () => {
		const { token } = await created({ maxBytes: STORED });
		await upload("initiate", token);

		const response = await upload("complete", token, completeBody);

		expect(response.status).toBe(200);
		expect(durationWrites()).toHaveLength(1);
		expect(state.abort).not.toHaveBeenCalled();
	});

	it("adds the stored size of every part", async () => {
		const { token } = await created({ maxBytes: 3 * STORED - 1 });
		await upload("initiate", token);
		state.listParts.mockReturnValue(
			[1, 2, 3].map((part) => ({
				PartNumber: part,
				ETag: `"etag-${part}"`,
				Size: STORED,
			})),
		);

		const response = await upload("complete", token, {
			...completeBody,
			parts: [1, 2, 3].map((part) => ({
				partNumber: part,
				etag: `etag-${part}`,
				size: STORED,
			})),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ code: "file_too_large" });
		expect(durationWrites()).toHaveLength(0);
	});

	it("refuses initiate before anything is uploaded when the declared size is over the cap", async () => {
		const { token } = await created({ maxBytes: 250_000_000 });

		const over = await upload("initiate", token, {
			contentLength: 250_000_001,
		});

		expect(over.status).toBe(400);
		expect(await over.json()).toMatchObject({
			code: "file_too_large",
			error:
				"The file is larger than the 250000000 byte limit set for this upload",
			hint: expect.stringContaining("No upload was opened."),
		});
		expect(storageCalls()).toBe(0);

		const within = await upload("initiate", token, {
			contentLength: 250_000_000,
		});
		expect(within.status).toBe(200);
		expect(state.create).toHaveBeenCalledTimes(1);
	});

	it("refuses a declared size over the product limit on a token with no cap", async () => {
		const { token } = await created();

		const response = await upload("initiate", token, {
			contentLength: 36_000_000_001,
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			code: "file_too_large",
			error: "The file is larger than the 36 GB upload limit",
		});
		expect(storageCalls()).toBe(0);
	});

	it("still accepts a token issued before the cap existed", async () => {
		const { videoId } = await created();
		expect(videoId).toBe("video-1");
		const issuedBeforeTheCap =
			"cut_eyJ2IjoxLCJhcHAiOiJhcHAxIiwidmlkZW8iOiJ2aWRlby0xIiwiZXhwIjoxNzk0NDgxMjAwMDAwLCJvcmlnaW4iOm51bGx9.fMI6nUNp1BF0VWSS3A5xA1jeK3ghEPavCqVE4uW0xNI";

		const initiated = await upload("initiate", issuedBeforeTheCap);
		const completed = await upload(
			"complete",
			issuedBeforeTheCap,
			completeBody,
		);

		expect(initiated.status).toBe(200);
		expect(completed.status).toBe(200);
		expect(durationWrites()).toHaveLength(1);
		vi.setSystemTime(Date.parse("2026-11-12T11:00:00Z"));
		expect((await upload("initiate", issuedBeforeTheCap)).status).toBe(401);
	});

	it("does not cap a token made without maxBytes", async () => {
		const { token } = await created();
		await upload("initiate", token, { contentLength: 30_000_000_000 });

		const response = await upload("complete", token, completeBody);

		expect(response.status).toBe(200);
	});

	it("applies the cap sent with a renewal, not the first token's", async () => {
		const first = await created({ maxBytes: STORED - 1 });
		await upload("initiate", first.token);

		const next = await renewed(first.videoId, { maxBytes: STORED });
		const response = await upload("complete", next.token, completeBody);

		expect(response.status).toBe(200);
		expect(durationWrites()).toHaveLength(1);
	});
});

describe("fields Create Upload does not know", () => {
	it.each([
		["user_id", { user_id: "alice", name: "Clip" }],
		["externalUserId", { externalUserId: "alice" }],
		["timeout", { timeout: 600 }],
		["UserId", { UserId: "alice", userId: "alice" }],
	])("refuses %s, names it and creates nothing", async (field, body) => {
		const response = await createUpload(body);

		expect(response.status).toBe(400);
		const refusal = await response.json();
		expect(refusal).toMatchObject({
			code: "invalid_request",
			error: `Invalid request: Unrecognized key: "${field}"`,
			hint: "This request accepts name, userId, maxResolutionTier, metadata, corsOrigin, timeoutSeconds, maxBytes. Field names are case-sensitive.",
			docs: "https://cap.so/docs/api/rest-api",
		});
		expect(refusal.issues).toEqual([
			expect.objectContaining({ code: "unrecognized_keys", keys: [field] }),
		]);
		expect(inserts()).toHaveLength(0);
		expect(state.admission).not.toHaveBeenCalled();
	});

	it("keeps the usual hint for a known field with a wrong value", async () => {
		const response = await createUpload({ userId: 42 });

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			code: "invalid_request",
			hint: "Fix the fields listed in issues, then send the request again.",
		});
	});
});
