import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const API_KEY = "0123456789abcdef0123456789abcdef0123";
const SECRET = "SECRET-acquisition-of-initech";

type TestUser = {
	id: string;
	email: string;
	stripeSubscriptionStatus: string | null;
	thirdPartyStripeSubscriptionId: string | null;
};

const mocks = vi.hoisted(() => ({
	user: null as TestUser | null,
	env: {} as Record<string, string | undefined>,
	aiConfigured: true,
	upload: vi.fn(),
	submit: vi.fn(),
	get: vi.fn(),
	remove: vi.fn(),
	streamText: vi.fn(),
	generateText: vi.fn(),
	after: [] as Array<() => unknown>,
	completeFails: false,
	trialLookupFails: false,
	trial: new Map<string, string[]>(),
	trialState: new Map<
		string,
		{ completed: boolean; runs: number; asks: number }
	>(),
	daily: vi.fn(),
	shareUpsert: vi.fn(),
	shareDelete: vi.fn(),
}));

vi.mock("@/lib/meetings/share", () => ({
	upsertSharedNote: mocks.shareUpsert,
	deleteSharedNote: mocks.shareDelete,
}));
vi.mock("@/lib/desktop-share-url", () => ({
	getDesktopShareUrl: async () => undefined,
}));

vi.mock("@/lib/meetings/audio-usage", () => ({
	consumeDailyAudioUnits: mocks.daily,
}));

// Mirrors lib/meetings/trial.ts (covered against MySQL in
// __tests__/integration/meetings-trial-database.test.ts). Meetings put in
// mocks.trial directly count as written once.
vi.mock("@/lib/meetings/trial", () => {
	const limit = 3;
	const claimed = (userId: string) => mocks.trial.get(userId) ?? [];
	const state = (userId: string, meetingId: string) => {
		const key = `${userId}|${meetingId}`;
		const existing = mocks.trialState.get(key) ?? {
			completed: true,
			runs: 1,
			asks: 0,
		};
		mocks.trialState.set(key, existing);
		return existing;
	};
	return {
		MEETING_NOTES_TRIAL_MEETINGS: limit,
		trialRemaining: async (userId: string, max = limit) => {
			if (mocks.trialLookupFails)
				throw new Error("Table 'meeting_notes_trial_uses' doesn't exist");
			return Math.max(0, max - claimed(userId).length);
		},
		claimTrialMeeting: async (
			userId: string,
			meetingId: string,
			max = limit,
		) => {
			const list = claimed(userId);
			if (list.includes(meetingId)) {
				const row = state(userId, meetingId);
				if (!row.completed) return "busy";
				if (row.runs >= 3) return "runs_exhausted";
				row.runs += 1;
				return "already_claimed";
			}
			if (list.length >= max) return "exhausted";
			mocks.trial.set(userId, [...list, meetingId]);
			mocks.trialState.set(`${userId}|${meetingId}`, {
				completed: false,
				runs: 1,
				asks: 0,
			});
			return "claimed";
		},
		completeTrialMeeting: async (userId: string, meetingId: string) => {
			if (mocks.completeFails) throw new Error("database down");
			if (claimed(userId).includes(meetingId))
				state(userId, meetingId).completed = true;
		},
		releaseTrialMeeting: async (userId: string, meetingId: string) => {
			if (!claimed(userId).includes(meetingId)) return;
			if (state(userId, meetingId).completed) return;
			mocks.trialState.delete(`${userId}|${meetingId}`);
			mocks.trial.set(
				userId,
				claimed(userId).filter((id) => id !== meetingId),
			);
		},
		spendTrialAsk: async (userId: string, meetingId: string) => {
			if (!claimed(userId).includes(meetingId)) return false;
			const row = state(userId, meetingId);
			if (!row.completed || row.asks >= 5) return false;
			row.asks += 1;
			return true;
		},
	};
});

vi.mock("server-only", () => ({}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				leftJoin: () => ({
					where: async () => (mocks.user ? [{ users: mocks.user }] : []),
				}),
			}),
		}),
	}),
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: vi.fn(async () => null),
}));
vi.mock("@cap/database/auth/request-site", () => ({
	isCrossSiteCookieWrite: () => false,
}));
vi.mock("@cap/database/auth/domain-utils", () => ({
	isBlockedAccountEmail: () => false,
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => mocks.env,
	buildEnv: {
		NEXT_PUBLIC_WEB_URL: "https://cap.so",
		NEXT_PUBLIC_IS_CAP: "true",
	},
}));

vi.mock("next/server", () => ({
	after: (task: () => unknown) => {
		mocks.after.push(task);
	},
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@vercel/firewall", () => ({ checkRateLimit: vi.fn() }));

vi.mock("assemblyai", () => ({
	AssemblyAI: class {
		files = { upload: mocks.upload };
		transcripts = {
			submit: mocks.submit,
			get: mocks.get,
			delete: mocks.remove,
		};
	},
}));

vi.mock("@/lib/ai/provider", () => ({
	isAiConfigured: () => mocks.aiConfigured,
	getAiProviderChain: () => [
		{
			provider: "openai",
			modelId: "test-model",
			model: () => "test-model",
			supportsStreaming: true,
			supportsTemperature: true,
			defaultMaxOutputTokens: 2_000,
		},
	],
}));

vi.mock("ai", async (importOriginal) => ({
	...(await importOriginal<typeof import("ai")>()),
	streamText: mocks.streamText,
	generateText: mocks.generateText,
	gateway: (id: string) => `gateway:${id}`,
}));

const meetings = await import("@/app/api/desktop/[...route]/meetings");
const aiConfig = await import("@/lib/meetings/ai-config");
const app = new Hono()
	.basePath("/api/desktop")
	.route("/meetings", meetings.app);

let userCounter = 0;
const signIn = (status: string | null = "active") => {
	userCounter += 1;
	mocks.user = {
		id: `user-${userCounter}`,
		email: `person${userCounter}@example.com`,
		stripeSubscriptionStatus: status,
		thirdPartyStripeSubscriptionId: null,
	};
	return mocks.user;
};

const call = (
	path: string,
	init: {
		method?: string;
		body?: BodyInit;
		headers?: Record<string, string>;
		auth?: boolean;
	} = {},
) =>
	app.request(`https://cap.so/api/desktop/meetings${path}`, {
		method: init.method ?? "POST",
		body: init.body,
		headers: {
			...(init.auth === false ? {} : { authorization: `Bearer ${API_KEY}` }),
			...init.headers,
		},
	});

function wav(samples: number, sampleRate = 16_000): Uint8Array<ArrayBuffer> {
	const dataBytes = samples * 2;
	const out = new Uint8Array(44 + dataBytes);
	const view = new DataView(out.buffer);
	out.set([0x52, 0x49, 0x46, 0x46]);
	view.setUint32(4, 36 + dataBytes, true);
	out.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20], 8);
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	out.set([0x64, 0x61, 0x74, 0x61], 36);
	view.setUint32(40, dataBytes, true);
	return out;
}

const transcribe = (
	body: Uint8Array<ArrayBuffer>,
	query = "",
	headers: Record<string, string> = {},
) =>
	call(`/transcribe${query}`, {
		body,
		headers: { "content-type": "audio/wav", ...headers },
	});

const postJson = (path: string, body: unknown) =>
	call(path, {
		body: typeof body === "string" ? body : JSON.stringify(body),
		headers: { "content-type": "application/json" },
	});

const textStream = (parts: unknown[]) =>
	new ReadableStream({
		start(controller) {
			for (const part of parts) controller.enqueue(part);
			controller.close();
		},
	});

const deltas = (...texts: string[]) => [
	...texts.map((text) => ({ type: "text-delta", id: "t", text })),
	{ type: "finish" },
];

async function readEvents(response: Response) {
	const raw = await response.text();
	return raw
		.split("\n\n")
		.filter((block) => block && !block.startsWith(":"))
		.map((block) => {
			const [eventLine = "", dataLine = ""] = block.split("\n");
			return {
				event: eventLine.replace(/^event: /, ""),
				data: JSON.parse(dataLine.replace(/^data: /, "")) as Record<
					string,
					unknown
				>,
			};
		});
}

const logged = () =>
	JSON.stringify(
		[console.log, console.error, console.warn].flatMap((fn) =>
			vi
				.mocked(fn)
				.mock.calls.map((args) =>
					args.map((arg) =>
						arg instanceof Error
							? `${arg.name}:${arg.message}:${arg.stack}:${JSON.stringify(arg)}`
							: arg,
					),
				),
		),
	);

beforeEach(() => {
	aiConfig.resetMeetingsAiConfigCache();
	mocks.user = null;
	mocks.env = {
		ASSEMBLY_API_KEY: "test-key",
		ASSEMBLY_BASE_URL: "https://speech.example/asr",
		NEXTAUTH_SECRET: "test-secret",
		WEB_URL: "https://cap.so",
	};
	mocks.aiConfigured = true;
	mocks.after = [];
	mocks.trial.clear();
	mocks.trialState.clear();
	mocks.completeFails = false;
	mocks.trialLookupFails = false;
	for (const fn of [
		mocks.upload,
		mocks.submit,
		mocks.get,
		mocks.remove,
		mocks.streamText,
		mocks.generateText,
		mocks.shareUpsert,
		mocks.shareDelete,
	])
		fn.mockReset();
	mocks.daily.mockReset();
	mocks.daily.mockResolvedValue({ allowed: true });
	mocks.upload.mockResolvedValue("https://cdn.example/upload/1");
	mocks.remove.mockResolvedValue({});
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("GET /capabilities", () => {
	it("requires auth", async () => {
		const response = await call("/capabilities", {
			method: "GET",
			auth: false,
		});
		expect(response.status).toBe(401);
	});

	it("reports nothing for a free user, with limits", async () => {
		signIn("canceled");
		const response = await call("/capabilities", { method: "GET" });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			transcription: false,
			notes: false,
			notesTrialRemaining: 3,
			limits: {
				maxClipSeconds: 120,
				maxClipBytes: 4_000_000,
				maxTranscriptChars: 400_000,
			},
		});
	});

	it("reports each feature by entitlement and configuration", async () => {
		signIn("past_due");
		expect(
			await (await call("/capabilities", { method: "GET" })).json(),
		).toMatchObject({ transcription: true, notes: true });
		mocks.env = {};
		mocks.aiConfigured = false;
		expect(
			await (await call("/capabilities", { method: "GET" })).json(),
		).toMatchObject({ transcription: false, notes: false });
	});
});

describe("cloud transcription only through Cap's speech service", () => {
	const capabilities = async () =>
		(await (await call("/capabilities", { method: "GET" })).json()) as {
			transcription: boolean;
		};

	it.each([
		["unset", undefined],
		["AssemblyAI", "https://api.assemblyai.com"],
		["an AssemblyAI region", "https://api.eu.assemblyai.com/"],
		["AssemblyAI with a trailing dot", "https://API.AssemblyAI.com./v2"],
		["not a URL", "speech.example"],
	])("is off when ASSEMBLY_BASE_URL is %s", async (_label, baseUrl) => {
		signIn();
		mocks.env.ASSEMBLY_BASE_URL = baseUrl;
		expect((await capabilities()).transcription).toBe(false);
		const response = await transcribe(wav(16_000));
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: "not_configured" });
		expect(mocks.upload).not.toHaveBeenCalled();
		expect(mocks.submit).not.toHaveBeenCalled();
	});

	it("is on when ASSEMBLY_BASE_URL is Cap's own service", async () => {
		signIn();
		expect((await capabilities()).transcription).toBe(true);
	});

	it("queues meeting clips as ordinary audio, never as live captions", async () => {
		signIn();
		mocks.submit.mockResolvedValue({
			id: "tr_p",
			status: "completed",
			text: "hi",
			language_code: "en",
			words: [],
		});
		expect((await transcribe(wav(16_000), "?language=en")).status).toBe(200);
		const params = mocks.submit.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(params).not.toHaveProperty("cap_priority");
		expect(params).not.toHaveProperty("cap_context_ms");
		expect(Object.keys(params).filter((key) => key.startsWith("cap_"))).toEqual(
			[],
		);
	});
});

describe("mounting", () => {
	it("runs meetings auth only under /meetings", async () => {
		const other = new Hono().get("/plan", (c) => c.text("ok"));
		const desktop = new Hono()
			.basePath("/api/desktop")
			.route("/meetings", meetings.app)
			.route("/", other);
		const response = await desktop.request("https://cap.so/api/desktop/plan");
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok");
	});
});

describe("sign-in failures", () => {
	let address = 0;
	const fromAddress = () => {
		address += 1;
		return `198.51.100.${address}`;
	};
	const capabilities = (
		ip: string,
		key = "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0",
	) =>
		app.request("https://cap.so/api/desktop/meetings/capabilities", {
			headers: { authorization: `Bearer ${key}`, "x-forwarded-for": ip },
		});

	it("limits refused sign-ins per address", async () => {
		const ip = fromAddress();
		for (let index = 0; index < 60; index++)
			expect((await capabilities(ip)).status).toBe(401);
		const limited = await capabilities(ip);
		expect(limited.status).toBe(429);
		expect(limited.headers.get("retry-after")).toBe("60");
		expect(await limited.json()).toEqual({
			error: "rate_limited",
			retryAfterSeconds: 60,
		});
		expect((await capabilities(ip)).status).toBe(429);
		expect((await capabilities(fromAddress())).status).toBe(401);
	});

	it("still serves every signed-in user on a limited address", async () => {
		const ip = fromAddress();
		for (let index = 0; index < 61; index++) await capabilities(ip);
		expect((await capabilities(ip)).status).toBe(429);
		signIn();
		expect((await capabilities(ip)).status).toBe(200);
		expect(
			(await capabilities(ip, "fedcba9876543210fedcba9876543210fedc")).status,
		).toBe(200);
	});

	it("answers requests without a desktop key from a limited address without a lookup", async () => {
		const ip = fromAddress();
		for (let index = 0; index < 61; index++) await capabilities(ip);
		signIn();
		const response = await app.request(
			"https://cap.so/api/desktop/meetings/capabilities",
			{ headers: { authorization: "Bearer short", "x-forwarded-for": ip } },
		);
		expect(response.status).toBe(429);
	});

	it("never counts signed-in requests against the address", async () => {
		const ip = fromAddress();
		signIn();
		for (let index = 0; index < 150; index++)
			expect((await capabilities(ip)).status).toBe(200);
	});
});

describe("POST /transcribe gates", () => {
	it("rejects missing auth before anything else", async () => {
		const response = await transcribe(wav(16_000), "", {});
		expect(
			(await call("/transcribe", { auth: false, body: wav(16_000) })).status,
		).toBe(401);
		expect(response.status).toBe(401);
		expect(mocks.upload).not.toHaveBeenCalled();
	});

	it("checks Pro before configuration and validation", async () => {
		signIn(null);
		mocks.env = {};
		const response = await transcribe(
			new Uint8Array([1, 2, 3]),
			"?language=xx",
		);
		expect(response.status).toBe(402);
		expect(await response.json()).toEqual({ error: "upgrade_required" });
	});

	it("returns not_configured without a speech key", async () => {
		signIn();
		mocks.env = {};
		const response = await transcribe(wav(16_000), "?language=xx");
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: "not_configured" });
	});

	it("validates query and content type", async () => {
		signIn();
		const badLanguage = await transcribe(wav(16_000), "?language=xx");
		expect(badLanguage.status).toBe(400);
		expect(await badLanguage.json()).toEqual({
			error: "invalid_request",
			detail: "language: unsupported language",
		});

		const badType = await call("/transcribe", {
			body: wav(16_000),
			headers: { "content-type": "audio/mpeg" },
		});
		expect(badType.status).toBe(400);
		expect(mocks.upload).not.toHaveBeenCalled();
	});

	it("rejects keywords in the URL before touching the provider", async () => {
		signIn();
		const response = await transcribe(wav(16_000), "?keywords=Cap");
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "invalid_request",
			detail: "keywords: send them in the x-cap-keywords header",
		});
		expect(mocks.upload).not.toHaveBeenCalled();
	});

	it("returns 413 for oversize bodies", async () => {
		signIn();
		const response = await transcribe(new Uint8Array(4_000_001));
		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({ error: "payload_too_large" });
	});

	it("rejects audio that is not 16 kHz mono 16-bit PCM", async () => {
		signIn();
		const response = await transcribe(wav(16_000, 48_000));
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "invalid_request",
			detail: "audio: unsupported_format",
		});
		expect(mocks.upload).not.toHaveBeenCalled();
	});

	it("refuses audio over the daily cap before the provider, until the next day", async () => {
		const user = signIn();
		mocks.daily.mockResolvedValue({ allowed: false, retryAfterSeconds: 4_321 });
		const response = await transcribe(wav(16_000 * 25));
		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("4321");
		expect(await response.json()).toEqual({
			error: "daily_audio_limit",
			retryAfterSeconds: 4_321,
		});
		expect(mocks.daily).toHaveBeenCalledWith(user.id, 3, 5_760);
		expect(mocks.upload).not.toHaveBeenCalled();
	});

	it("answers clips under 100 ms without calling the provider", async () => {
		signIn();
		const response = await transcribe(wav(1_599));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			text: "",
			language: null,
			durationMs: 100,
			words: [],
		});
		const tiny = await transcribe(wav(800));
		expect(await tiny.json()).toMatchObject({ durationMs: 50, words: [] });
		expect(mocks.upload).not.toHaveBeenCalled();
	});
});

describe("POST /transcribe", () => {
	it("transcribes, maps words, passes keyterms and deletes the provider copy", async () => {
		signIn();
		mocks.submit.mockResolvedValue({ id: "tr_1", status: "queued" });
		mocks.get.mockResolvedValue({
			id: "tr_1",
			status: "completed",
			text: "Hello Cap.",
			language_code: "en",
			words: [
				{
					text: "Hello",
					start: 120,
					end: 480,
					confidence: 0.98,
					speaker: null,
				},
				{ text: "Cap.", start: 500, end: 900, confidence: 0.91, speaker: null },
			],
		});

		const response = await transcribe(wav(32_000), "?language=en", {
			"x-cap-keywords": `Cap,%20Fable,${encodeURIComponent("Zürich")}`,
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			text: "Hello Cap.",
			language: "en",
			durationMs: 2_000,
			words: [
				{ text: "Hello", startMs: 120, endMs: 480, confidence: 0.98 },
				{ text: "Cap.", startMs: 500, endMs: 900, confidence: 0.91 },
			],
		});
		expect(mocks.submit).toHaveBeenCalledWith(
			expect.objectContaining({
				audio: "https://cdn.example/upload/1",
				language_code: "en",
				keyterms_prompt: ["Cap", "Fable", "Zürich"],
			}),
		);
		expect(mocks.upload.mock.calls[0]?.[0]).toHaveLength(44 + 64_000);

		expect(mocks.after).toHaveLength(1);
		await mocks.after[0]?.();
		expect(mocks.remove).toHaveBeenCalledWith("tr_1");
	});

	it("asks for speaker labels in a per-user session and returns the letters", async () => {
		signIn();
		mocks.submit.mockResolvedValue({
			id: "tr_s",
			status: "completed",
			text: "Hi there.",
			language_code: "en",
			words: [
				{ text: "Hi", start: 100, end: 300, confidence: 0.9, speaker: "A" },
				{
					text: "there.",
					start: 320,
					end: 700,
					confidence: 0.9,
					speaker: null,
				},
			],
		});
		const response = await transcribe(
			wav(16_000),
			"?session=doc_1:system&seq=4",
		);
		expect(response.status).toBe(200);
		expect((await response.json()).words).toEqual([
			{ text: "Hi", startMs: 100, endMs: 300, confidence: 0.9, speaker: "A" },
			{
				text: "there.",
				startMs: 320,
				endMs: 700,
				confidence: 0.9,
				speaker: null,
			},
		]);
		const params = mocks.submit.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(params).toMatchObject({ speaker_labels: true, cap_speaker_seq: 4 });
		expect(String(params.cap_speaker_session)).toMatch(/^.+:doc_1:system$/);
		expect(String(params.cap_speaker_session)).not.toBe("doc_1:system");
	});

	it("sends no speaker fields without a session", async () => {
		signIn();
		mocks.submit.mockResolvedValue({
			id: "tr_n",
			status: "completed",
			text: "",
			language_code: "en",
			words: [],
		});
		await transcribe(wav(16_000));
		const params = mocks.submit.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(params).not.toHaveProperty("speaker_labels");
		expect(params).not.toHaveProperty("cap_speaker_session");
	});

	it("rejects a malformed speaker session", async () => {
		signIn();
		const response = await transcribe(wav(16_000), "?session=a%20b");
		expect(response.status).toBe(400);
		expect(mocks.submit).not.toHaveBeenCalled();
	});

	it("drops keyterms the provider rejects", async () => {
		signIn();
		mocks.submit
			.mockRejectedValueOnce(new Error("keyterms_prompt not supported"))
			.mockResolvedValueOnce({
				id: "tr_2",
				status: "completed",
				text: "ok",
				language_code: "de",
				words: [],
			});
		const response = await transcribe(wav(16_000), "", {
			"x-cap-keywords": "Cap",
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ text: "ok", language: "de" });
		expect(mocks.submit).toHaveBeenCalledTimes(2);
		expect(mocks.submit.mock.calls[1]?.[0]).not.toHaveProperty(
			"keyterms_prompt",
		);
		expect(mocks.submit.mock.calls[1]?.[0]).toHaveProperty(
			"language_detection",
			true,
		);
	});

	it("returns empty text when the clip has no speech", async () => {
		signIn();
		mocks.submit.mockResolvedValue({
			id: "tr_3",
			status: "error",
			error: "No spoken audio found",
		});
		const response = await transcribe(wav(16_000));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			text: "",
			language: null,
			durationMs: 1_000,
			words: [],
		});
	});

	it("lets go of a stalled speech call when the app disconnects", async () => {
		signIn();
		mocks.upload.mockReturnValue(new Promise(() => {}));
		const controller = new AbortController();
		const pending = app.request(
			"https://cap.so/api/desktop/meetings/transcribe",
			{
				method: "POST",
				body: wav(16_000),
				headers: {
					authorization: `Bearer ${API_KEY}`,
					"content-type": "audio/wav",
				},
				signal: controller.signal,
			},
		);
		setTimeout(() => controller.abort(), 20);
		const response = await pending;
		expect(response.status).toBe(502);
		expect(mocks.submit).not.toHaveBeenCalled();
	});

	it("still deletes a provider copy submitted after the app disconnected", async () => {
		signIn();
		mocks.submit.mockReturnValue(
			new Promise((resolve) =>
				setTimeout(() => resolve({ id: "tr_late", status: "queued" }), 60),
			),
		);
		const controller = new AbortController();
		const pending = app.request(
			"https://cap.so/api/desktop/meetings/transcribe",
			{
				method: "POST",
				body: wav(16_000),
				headers: {
					authorization: `Bearer ${API_KEY}`,
					"content-type": "audio/wav",
				},
				signal: controller.signal,
			},
		);
		setTimeout(() => controller.abort(), 20);
		expect((await pending).status).toBe(502);
		expect(mocks.after).toHaveLength(1);
		await mocks.after[0]?.();
		expect(mocks.remove).toHaveBeenCalledWith("tr_late");
	});

	it("returns 502 when the provider fails", async () => {
		signIn();
		mocks.submit.mockResolvedValue({
			id: "tr_4",
			status: "error",
			error: "Transcoding failed",
		});
		const response = await transcribe(wav(16_000));
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({ error: "transcription_failed" });
	});
});

const validNotes = {
	title: "",
	transcript: `Speaker 1: ${SECRET}. We ship Friday.`,
	rawNotesMarkdown: "- ship Friday",
};

describe("POST /notes gates", () => {
	it("refuses a new meeting once the free meetings are used", async () => {
		const user = signIn("canceled");
		mocks.trial.set(user.id, ["a", "b", "c"]);
		const response = await postJson("/notes", {
			...validNotes,
			meetingId: "d",
		});
		expect(response.status).toBe(402);
		expect(mocks.streamText).not.toHaveBeenCalled();
	});

	it("returns not_configured when no AI provider is set", async () => {
		signIn();
		mocks.aiConfigured = false;
		const response = await postJson("/notes", validNotes);
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: "not_configured" });
	});

	it("rejects invalid bodies without echoing them", async () => {
		signIn();
		const notJson = await postJson("/notes", `{"transcript": "${SECRET}`);
		expect(notJson.status).toBe(400);
		const notJsonBody = await notJson.json();
		expect(notJsonBody).toEqual({
			error: "invalid_request",
			detail: "body: must be valid UTF-8 JSON",
		});

		const invalid = await postJson("/notes", {
			...validNotes,
			summaryLanguage: SECRET,
		});
		expect(invalid.status).toBe(400);
		const invalidBody = (await invalid.json()) as { detail: string };
		expect(invalidBody.detail.startsWith("summaryLanguage:")).toBe(true);
		expect(JSON.stringify(invalidBody)).not.toContain(SECRET);
		expect(mocks.streamText).not.toHaveBeenCalled();
	});

	it("accepts only JSON bodies", async () => {
		signIn();
		for (const path of ["/notes", "/ask"]) {
			for (const type of ["text/plain", "application/x-www-form-urlencoded"]) {
				const response = await call(path, {
					body: JSON.stringify({ ...validNotes, question: "q" }),
					headers: { "content-type": type },
				});
				expect(response.status).toBe(400);
				expect(((await response.json()) as { detail: string }).detail).toBe(
					"content-type: must be application/json",
				);
			}
		}
		expect(mocks.streamText).not.toHaveBeenCalled();
	});

	it("charges large bodies more of the hourly budget", async () => {
		signIn();
		mocks.streamText.mockImplementation(() => ({
			fullStream: textStream(deltas("## Notes\n", "- ok")),
		}));
		mocks.generateText.mockResolvedValue({ text: "- part" });
		// 250 KB: one unit on arrival and two more for the body.
		const large = {
			...validNotes,
			title: "Weekly",
			transcript: "x".repeat(250_000),
		};
		for (let index = 0; index < 20; index++) {
			const response = await postJson("/notes", large);
			expect(response.status).toBe(200);
			await response.text();
		}
		expect((await postJson("/notes", large)).status).toBe(429);
		expect(mocks.streamText).toHaveBeenCalledTimes(20);
	});

	it("returns 413 for oversize bodies", async () => {
		signIn();
		const response = await postJson("/notes", "x".repeat(4_000_001));
		expect(response.status).toBe(413);
	});

	it("rate limits at 60 requests per hour, before validation", async () => {
		signIn();
		for (let index = 0; index < 60; index++) {
			expect((await postJson("/notes", "{}")).status).toBe(400);
		}
		const limited = await postJson("/notes", "{}");
		expect(limited.status).toBe(429);
		const body = (await limited.json()) as {
			error: string;
			retryAfterSeconds: number;
		};
		expect(body.error).toBe("rate_limited");
		expect(body.retryAfterSeconds).toBeGreaterThan(0);
		expect(limited.headers.get("retry-after")).toBe(
			String(body.retryAfterSeconds),
		);
	});
});

describe("POST /notes", () => {
	it("streams a title, deltas and done", async () => {
		signIn();
		mocks.streamText.mockReturnValue({
			fullStream: textStream(
				deltas("Title: Launch ", "plan\n\n## Scope\n", "- Ship Friday"),
			),
		});

		const response = await postJson("/notes", validNotes);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		expect(await readEvents(response)).toEqual([
			{ event: "title", data: { title: "Launch plan" } },
			{ event: "delta", data: { text: "## Scope\n" } },
			{ event: "delta", data: { text: "- Ship Friday" } },
			{ event: "done", data: { chars: 22 } },
		]);

		const options = mocks.streamText.mock.calls[0]?.[0];
		expect(options.system).not.toContain(SECRET);
		expect(options.messages[0].content).toContain(SECRET);
		expect(options.maxOutputTokens).toBe(16_000);
		expect(options.abortSignal).toBeInstanceOf(AbortSignal);
		expect(mocks.generateText).not.toHaveBeenCalled();
		expect(logged()).not.toContain(SECRET);
	});

	it("does not send a title when the meeting has one", async () => {
		signIn();
		mocks.streamText.mockReturnValue({
			fullStream: textStream(deltas("## Scope\n- a")),
		});
		const events = await readEvents(
			await postJson("/notes", { ...validNotes, title: "Weekly" }),
		);
		expect(events.map((event) => event.event)).toEqual(["delta", "done"]);
	});

	it("condenses long transcripts in chunks when config lowers the single-pass size", async () => {
		signIn();
		mocks.env.MEETINGS_AI_CONFIG = JSON.stringify({
			notesSinglePassChars: 120_000,
		});
		mocks.generateText.mockResolvedValue({ text: "- part notes" });
		mocks.streamText.mockReturnValue({
			fullStream: textStream(deltas("## Notes\n- merged")),
		});
		const line = `Speaker 1: ${"word ".repeat(199)}`;
		const transcript = Array.from({ length: 130 }, () => line).join("\n");

		const events = await readEvents(
			await postJson("/notes", { title: "Long", transcript }),
		);
		expect(events.at(-1)?.event).toBe("done");
		expect(mocks.generateText).toHaveBeenCalledTimes(3);
		const final = mocks.streamText.mock.calls[0]?.[0];
		expect(final.messages[0].content).toContain("<section_notes_");
		expect(final.messages[0].content).not.toContain("<transcript_");
	});

	it("sends an error event and logs nothing from the request when generation fails", async () => {
		signIn();
		const providerError = Object.assign(new Error(`bad request ${SECRET}`), {
			name: "AI_APICallError",
			statusCode: 400,
			requestBodyValues: { messages: [{ content: SECRET }] },
			responseBody: SECRET,
		});
		mocks.streamText.mockReturnValue({
			fullStream: textStream([{ type: "error", error: providerError }]),
		});

		const events = await readEvents(await postJson("/notes", validNotes));
		expect(events).toEqual([
			{ event: "error", data: { error: "generation_failed" } },
		]);
		expect(logged()).toContain("AI_APICallError status=400");
		expect(logged()).not.toContain(SECRET);
	});
});

describe("free meetings for signed-in users", () => {
	const streamNotes = () =>
		mocks.streamText.mockReturnValue({
			fullStream: textStream(deltas("# Notes\n", "Done.")),
		});

	it("writes up the first three meetings, then asks for Pro", async () => {
		const user = signIn(null);
		for (const meetingId of ["m1", "m2", "m3"]) {
			streamNotes();
			const response = await postJson("/notes", {
				...validNotes,
				meetingId,
			});
			expect(response.status).toBe(200);
			await response.text();
		}
		expect(mocks.trial.get(user.id)).toEqual(["m1", "m2", "m3"]);
		const capabilities = await (
			await call("/capabilities", { method: "GET" })
		).json();
		expect(capabilities).toMatchObject({
			notes: false,
			notesTrialRemaining: 0,
		});
		const fourth = await postJson("/notes", { ...validNotes, meetingId: "m4" });
		expect(fourth.status).toBe(402);
		expect(await fourth.json()).toEqual({ error: "upgrade_required" });
	});

	it("rewriting a free meeting does not use another one", async () => {
		const user = signIn(null);
		for (let index = 0; index < 3; index++) {
			streamNotes();
			const response = await postJson("/notes", {
				...validNotes,
				meetingId: "same",
			});
			expect(response.status).toBe(200);
			await response.text();
		}
		expect(mocks.trial.get(user.id)).toEqual(["same"]);
	});

	it("still rewrites a free meeting after all of them are used", async () => {
		const user = signIn(null);
		mocks.trial.set(user.id, ["a", "b", "c"]);
		streamNotes();
		const response = await postJson("/notes", {
			...validNotes,
			meetingId: "b",
		});
		expect(response.status).toBe(200);
		await response.text();
		expect(mocks.trial.get(user.id)).toEqual(["a", "b", "c"]);
	});

	it("asks a second request to wait while the meeting is first written", async () => {
		const user = signIn(null);
		mocks.trial.set(user.id, ["m1"]);
		mocks.trialState.set(`${user.id}|m1`, {
			completed: false,
			runs: 1,
			asks: 0,
		});
		const response = await postJson("/notes", {
			...validNotes,
			meetingId: "m1",
		});
		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("30");
		expect(mocks.streamText).not.toHaveBeenCalled();
	});

	it("stops rewriting and asking about a free meeting after its allowance", async () => {
		const user = signIn(null);
		mocks.trial.set(user.id, ["m1"]);
		mocks.trialState.set(`${user.id}|m1`, {
			completed: true,
			runs: 3,
			asks: 5,
		});
		expect(
			(await postJson("/notes", { ...validNotes, meetingId: "m1" })).status,
		).toBe(402);
		expect(
			(
				await postJson("/ask", {
					question: "When?",
					transcript: "t",
					meetingId: "m1",
				})
			).status,
		).toBe(402);
		expect(mocks.streamText).not.toHaveBeenCalled();
	});

	it("counts a free meeting whose notes reached the app before the stream failed", async () => {
		const user = signIn(null);
		mocks.streamText.mockReturnValue({
			fullStream: textStream([
				{ type: "text-delta", id: "t", text: "# Notes\nAll of it." },
				{ type: "error", error: new Error("connection dropped") },
			]),
		});
		const events = await readEvents(
			await postJson("/notes", { ...validNotes, meetingId: "m1" }),
		);
		expect(events.map((event) => event.event)).toContain("delta");
		expect(events.at(-1)?.event).toBe("error");
		expect(mocks.trial.get(user.id)).toEqual(["m1"]);
		expect(mocks.trialState.get(`${user.id}|m1`)?.completed).toBe(true);
	});

	it("only reports done once the free meeting is saved", async () => {
		const user = signIn(null);
		mocks.completeFails = true;
		streamNotes();
		const events = await readEvents(
			await postJson("/notes", { ...validNotes, meetingId: "m1" }),
		);
		expect(events.map((event) => event.event)).not.toContain("done");
		expect(events.at(-1)?.event).toBe("error");
		expect(mocks.trial.get(user.id)).toEqual(["m1"]);
	});

	it("cuts a long free meeting's transcript and says it is incomplete", async () => {
		const user = signIn(null);
		mocks.env.VERCEL_ENV = "production";
		streamNotes();
		const line = `Speaker 1: ${"word ".repeat(40)}\n`;
		const transcript = line
			.repeat(Math.ceil(400_000 / line.length))
			.slice(0, 399_000);
		const response = await postJson("/notes", {
			...validNotes,
			transcript,
			meetingId: "long",
		});
		expect(response.status).toBe(200);
		await response.text();
		const prompt = mocks.streamText.mock.calls[0]?.[0];
		const sent = prompt.messages[0].content as string;
		expect(Buffer.byteLength(sent)).toBeLessThan(260_000);
		expect(sent).toContain(line.slice(0, 40));
		expect(prompt.system).toContain("The transcript is incomplete");
		expect(mocks.trial.get(user.id)).toEqual(["long"]);
	});

	it("bounds what a free question sends, whatever the characters", async () => {
		const user = signIn(null);
		mocks.trial.set(user.id, ["m1"]);
		mocks.streamText.mockReturnValue({
			fullStream: textStream(deltas("Friday")),
		});
		const response = await postJson("/ask", {
			question: "When?",
			transcript: "\u{20000}".repeat(199_000),
			meetingId: "m1",
		});
		expect(response.status).toBe(200);
		await response.text();
		const sent = mocks.streamText.mock.calls[0]?.[0].messages
			.map((message: { content: string }) => message.content)
			.join("");
		expect(Buffer.byteLength(sent)).toBeLessThan(260_000);
		expect(sent).not.toContain("\uFFFD");
		expect(mocks.streamText.mock.calls[0]?.[0].system).toContain(
			"only the parts most related to the question are included",
		);
	});

	it("keeps the part of a long free meeting a question is about", async () => {
		const user = signIn(null);
		mocks.trial.set(user.id, ["m1"]);
		mocks.streamText.mockReturnValue({
			fullStream: textStream(deltas("PINEAPPLE")),
		});
		const filler = "Speaker 1: we went through the roadmap again.\n".repeat(
			8_000,
		);
		const response = await postJson("/ask", {
			question: "What is the code word for the launch?",
			transcript: `${filler}Speaker 2: the code word for the launch is PINEAPPLE.\n`,
			meetingId: "m1",
		});
		expect(response.status).toBe(200);
		await response.text();
		const sent = mocks.streamText.mock.calls[0]?.[0].messages[0].content;
		expect(Buffer.byteLength(sent)).toBeLessThan(260_000);
		expect(sent).toContain("PINEAPPLE");
	});

	it("refuses a free request that is too large without its transcript", async () => {
		const user = signIn(null);
		const response = await postJson("/notes", {
			...validNotes,
			meetingId: "huge",
			previous: { markdown: "€".repeat(99_000), instruction: "shorter" },
		});
		expect(response.status).toBe(402);
		expect(mocks.trial.get(user.id)).toBeUndefined();
		expect(mocks.streamText).not.toHaveBeenCalled();
	});

	it("leaves a Pro meeting's transcript whole", async () => {
		signIn();
		mocks.env.VERCEL_ENV = "production";
		streamNotes();
		const transcript = `Speaker 1: ${"x".repeat(299_000)}`;
		const response = await postJson("/notes", { ...validNotes, transcript });
		expect(response.status).toBe(200);
		await response.text();
		const prompt = mocks.streamText.mock.calls[0]?.[0];
		expect(prompt.messages[0].content).toContain(transcript);
		expect(prompt.system).not.toContain("The transcript is incomplete");
	});

	it("needs a meeting id to count against", async () => {
		signIn(null);
		expect((await postJson("/notes", validNotes)).status).toBe(402);
		expect(mocks.streamText).not.toHaveBeenCalled();
	});

	it("gives the meeting back when writing it fails", async () => {
		const user = signIn(null);
		mocks.streamText.mockImplementation(() => {
			throw new Error("provider down");
		});
		const response = await postJson("/notes", {
			...validNotes,
			meetingId: "m1",
		});
		await response.text();
		expect(mocks.trial.get(user.id) ?? []).toEqual([]);
	});

	it("counts the meeting when the model answers with nothing", async () => {
		const user = signIn(null);
		mocks.streamText.mockImplementation(() => ({
			fullStream: textStream([{ type: "finish" }]),
		}));
		const response = await postJson("/notes", {
			...validNotes,
			title: "Weekly",
			meetingId: "m1",
		});
		expect((await readEvents(response)).map((event) => event.event)).toEqual([
			"error",
		]);
		expect(mocks.trial.get(user.id)).toEqual(["m1"]);
		expect(mocks.trialState.get(`${user.id}|m1`)?.completed).toBe(true);

		for (const meetingId of ["m2", "m3"]) {
			await (
				await postJson("/notes", { ...validNotes, title: "Weekly", meetingId })
			).text();
		}
		expect(
			(
				await postJson("/notes", {
					...validNotes,
					title: "Weekly",
					meetingId: "m4",
				})
			).status,
		).toBe(402);
	});

	it("counts the meeting when the stream fails while its title is held", async () => {
		const user = signIn(null);
		mocks.streamText.mockImplementation(() => ({
			fullStream: textStream([
				{ type: "text-delta", id: "t", text: "Title: Launch" },
				{ type: "error", error: new Error("provider dropped") },
			]),
		}));
		const response = await postJson("/notes", {
			...validNotes,
			meetingId: "m1",
		});
		expect((await readEvents(response)).map((event) => event.event)).toEqual([
			"error",
		]);
		expect(mocks.trial.get(user.id)).toEqual(["m1"]);
	});

	it("counts the meeting when a long transcript was condensed before failing", async () => {
		const user = signIn(null);
		mocks.env.MEETINGS_AI_CONFIG = JSON.stringify({
			notesSinglePassChars: 20_000,
		});
		mocks.generateText.mockResolvedValue({ text: "- part" });
		mocks.streamText.mockImplementation(() => {
			throw new Error("provider down");
		});
		const response = await postJson("/notes", {
			...validNotes,
			title: "Weekly",
			transcript: "Speaker 1: words.\n".repeat(3_000),
			meetingId: "m1",
		});
		await response.text();
		expect(mocks.generateText).toHaveBeenCalled();
		expect(mocks.trial.get(user.id)).toEqual(["m1"]);
	});

	it("keeps the meeting claimed when the app hangs up before any notes", async () => {
		const user = signIn(null);
		// Like the SDK, the stream ends when its abort signal fires.
		mocks.streamText.mockImplementation(
			(options: { abortSignal?: AbortSignal }) => ({
				fullStream: new ReadableStream({
					start(stream) {
						options.abortSignal?.addEventListener("abort", () =>
							stream.error(new Error("aborted")),
						);
					},
				}),
			}),
		);
		const controller = new AbortController();
		const pending = app.request("https://cap.so/api/desktop/meetings/notes", {
			method: "POST",
			body: JSON.stringify({ ...validNotes, meetingId: "m1" }),
			headers: {
				authorization: `Bearer ${API_KEY}`,
				"content-type": "application/json",
			},
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 20);
		// The stream ends only after the run has settled the claim.
		await (await pending).text().catch(() => undefined);
		expect(mocks.trial.get(user.id)).toEqual(["m1"]);
	});

	it("answers questions only about meetings written up free", async () => {
		const user = signIn(null);
		mocks.trial.set(user.id, ["m1"]);
		mocks.streamText.mockReturnValue({
			fullStream: textStream(deltas("Friday")),
		});
		const ok = await postJson("/ask", {
			question: "When?",
			transcript: "t",
			meetingId: "m1",
		});
		expect(ok.status).toBe(200);
		await ok.text();
		const other = await postJson("/ask", {
			question: "When?",
			transcript: "t",
			meetingId: "m2",
		});
		expect(other.status).toBe(402);
	});

	it("answers without free meetings when the trial lookup fails", async () => {
		signIn(null);
		mocks.trialLookupFails = true;
		const response = await call("/capabilities", { method: "GET" });
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({ notes: false });
		expect(body).not.toHaveProperty("notesTrialRemaining");
	});

	it("does not offer free meetings when notes are not configured", async () => {
		signIn(null);
		mocks.aiConfigured = false;
		const body = await (await call("/capabilities", { method: "GET" })).json();
		expect(body).not.toHaveProperty("notesTrialRemaining");
	});
});

describe("POST /ask", () => {
	it("requires Pro", async () => {
		signIn("incomplete_expired");
		expect(
			(await postJson("/ask", { question: "q", transcript: "t" })).status,
		).toBe(402);
	});

	it("streams an answer grounded in the supplied meeting", async () => {
		signIn();
		mocks.streamText.mockReturnValue({
			fullStream: textStream(deltas("Friday", ".")),
		});
		const response = await postJson("/ask", {
			question: "When do we ship?",
			transcript: `Speaker 1: ${SECRET}. Friday.`,
			notesMarkdown: "",
			history: [
				{ role: "user", content: "Who attended?" },
				{ role: "assistant", content: "Ada." },
			],
		});
		expect(await readEvents(response)).toEqual([
			{ event: "delta", data: { text: "Friday" } },
			{ event: "delta", data: { text: "." } },
			{ event: "done", data: { chars: 7 } },
		]);
		const options = mocks.streamText.mock.calls[0]?.[0];
		expect(options.system).not.toContain(SECRET);
		expect(options.messages.map((m: { role: string }) => m.role)).toEqual([
			"user",
			"assistant",
			"user",
		]);
		expect(options.messages[0].content).toContain(SECRET);
		expect(options.messages[2].content).toBe("Question: When do we ship?");
		expect(options.maxOutputTokens).toBe(2_000);
		expect(logged()).not.toContain(SECRET);
	});
});

describe("remote control", () => {
	const streamNotes = () =>
		mocks.streamText.mockReturnValue({
			fullStream: textStream(deltas("Done.")),
		});

	it("keeps the Ask delimiter stable across a conversation", async () => {
		signIn();
		const ask = async (question: string) => {
			mocks.streamText.mockReturnValueOnce({
				fullStream: textStream(deltas("ok")),
			});
			await (
				await postJson("/ask", { question, transcript: "Speaker 1: hi" })
			).text();
			return mocks.streamText.mock.calls.at(-1)?.[0].messages[0].content;
		};
		expect(await ask("first?")).toMatch(/^<transcript_[0-9a-f]{16}>/);
		const one = (await ask("one?")).split("\n\nQuestion:")[0];
		const two = (await ask("two?")).split("\n\nQuestion:")[0];
		expect(two).toBe(one);
	});

	it("turns reasoning off for OpenAI models on the gateway", async () => {
		signIn();
		mocks.env.VERCEL_ENV = "production";
		mocks.streamText.mockReturnValue({ fullStream: textStream(deltas("x")) });
		await (await postJson("/notes", { ...validNotes, title: "T" })).text();
		expect(mocks.streamText.mock.calls[0]?.[0].providerOptions).toEqual({
			openai: { reasoningEffort: "none" },
		});
	});

	it("uses the gateway model from config on Vercel", async () => {
		signIn();
		mocks.env.VERCEL_ENV = "production";
		streamNotes();
		const response = await postJson("/notes", { ...validNotes, title: "T" });
		await response.text();
		expect(mocks.streamText.mock.calls[0]?.[0].model).toBe(
			"gateway:openai/gpt-6-luna",
		);
	});

	it("switches model and output budget from MEETINGS_AI_CONFIG", async () => {
		signIn();
		mocks.env.VERCEL_ENV = "production";
		mocks.env.MEETINGS_AI_CONFIG = JSON.stringify({
			notesModels: ["google/gemini-3.1-flash-lite", "openai/gpt-6-luna"],
			notesMaxOutputTokens: 9_000,
		});
		mocks.streamText
			.mockImplementationOnce(() => {
				throw new Error("first model down");
			})
			.mockReturnValueOnce({ fullStream: textStream(deltas("Done.")) });
		const response = await postJson("/notes", { ...validNotes, title: "T" });
		expect(await readEvents(response)).toContainEqual({
			event: "done",
			data: { chars: 5 },
		});
		const models = mocks.streamText.mock.calls.map((call) => call[0].model);
		expect(models).toEqual([
			"gateway:google/gemini-3.1-flash-lite",
			"gateway:openai/gpt-6-luna",
		]);
		expect(mocks.streamText.mock.calls[1]?.[0].maxOutputTokens).toBe(9_000);
	});

	it("switches notes off for everyone, including free meetings", async () => {
		const user = signIn(null);
		mocks.env.MEETINGS_AI_CONFIG = JSON.stringify({ notesEnabled: false });
		const capabilities = await (
			await call("/capabilities", { method: "GET" })
		).json();
		expect(capabilities.notes).toBe(false);
		expect(capabilities).not.toHaveProperty("notesTrialRemaining");
		const response = await postJson("/notes", {
			...validNotes,
			meetingId: "m1",
		});
		expect(response.status).toBe(503);
		expect(mocks.trial.get(user.id)).toBeUndefined();
		signIn();
		expect((await postJson("/notes", validNotes)).status).toBe(503);
	});

	it("keeps Ask on when only notes are switched off", async () => {
		signIn();
		mocks.env.MEETINGS_AI_CONFIG = JSON.stringify({ notesEnabled: false });
		mocks.streamText.mockReturnValue({
			fullStream: textStream(deltas("Friday")),
		});
		const response = await postJson("/ask", {
			question: "When?",
			transcript: "t",
		});
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("Friday");
	});

	it("switches Ask off on its own", async () => {
		signIn();
		mocks.env.MEETINGS_AI_CONFIG = JSON.stringify({ askEnabled: false });
		expect(
			(await postJson("/ask", { question: "q", transcript: "t" })).status,
		).toBe(503);
	});

	it("switches cloud transcription off", async () => {
		signIn();
		mocks.env.MEETINGS_AI_CONFIG = JSON.stringify({
			transcriptionEnabled: false,
		});
		const capabilities = await (
			await call("/capabilities", { method: "GET" })
		).json();
		expect(capabilities.transcription).toBe(false);
		expect((await transcribe(wav(16_000))).status).toBe(503);
	});

	it("changes how many meetings are free", async () => {
		signIn(null);
		mocks.env.MEETINGS_AI_CONFIG = JSON.stringify({ trialMeetings: 1 });
		const capabilities = await (
			await call("/capabilities", { method: "GET" })
		).json();
		expect(capabilities.notesTrialRemaining).toBe(1);
	});

	it("ignores invalid overrides and keeps the defaults", async () => {
		signIn();
		mocks.env.MEETINGS_AI_CONFIG = JSON.stringify({ notesModels: [] });
		const capabilities = await (
			await call("/capabilities", { method: "GET" })
		).json();
		expect(capabilities.notes).toBe(true);
	});
});

describe("note share links", () => {
	const note = {
		documentId: "doc_weekly-sync",
		title: "Weekly sync",
		summaryMarkdown: `## Summary\n\n${SECRET}`,
		transcript: [{ speaker: "Sam", startMs: 1_000, text: SECRET }],
		participants: ["Sam", "Priya"],
		startedAt: "2026-11-27T10:00:00+01:00",
		durationSeconds: 1_934,
	};
	const saved = { id: "0123456789abcde", orgId: "org-1", created: true };

	it("needs a sign-in to share or stop sharing", async () => {
		const share = await call("/share", {
			auth: false,
			body: JSON.stringify(note),
			headers: { "content-type": "application/json" },
		});
		const stop = await call("/share/doc_weekly-sync", {
			auth: false,
			method: "DELETE",
		});

		expect([share.status, stop.status]).toEqual([401, 401]);
		expect(mocks.shareUpsert).not.toHaveBeenCalled();
		expect(mocks.shareDelete).not.toHaveBeenCalled();
	});

	it("creates a link for a free account and returns it uncached", async () => {
		const user = signIn(null);
		mocks.shareUpsert.mockResolvedValue(saved);

		const response = await postJson("/share", note);

		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toEqual({
			id: saved.id,
			shareUrl: `https://cap.so/s/${saved.id}`,
			created: true,
		});
		expect(mocks.shareUpsert).toHaveBeenCalledWith(
			expect.objectContaining({ id: user.id }),
			expect.objectContaining({
				documentId: note.documentId,
				title: note.title,
				notesMarkdown: "",
				transcript: note.transcript,
			}),
		);
	});

	it("reports an update of the same document as not created", async () => {
		signIn();
		mocks.shareUpsert.mockResolvedValue({ ...saved, created: false });

		const response = await postJson("/share", note);

		expect(await response.json()).toMatchObject({
			id: saved.id,
			created: false,
		});
	});

	it.each([
		["text/plain", JSON.stringify(note), "content-type"],
		["application/json", "{", "body"],
	])("rejects a %s body it cannot read", async (type, body, field) => {
		signIn();

		const response = await call("/share", {
			body,
			headers: { "content-type": type },
		});

		expect(response.status).toBe(400);
		expect((await response.json()).detail).toContain(field);
		expect(mocks.shareUpsert).not.toHaveBeenCalled();
	});

	it("names the invalid field without repeating the note", async () => {
		signIn();

		const response = await postJson("/share", {
			...note,
			documentId: "../other",
		});
		const body = await response.text();

		expect(response.status).toBe(400);
		expect(body).toContain("documentId");
		expect(body).not.toContain(SECRET);
		expect(mocks.shareUpsert).not.toHaveBeenCalled();
	});

	it("refuses a body over the size limit", async () => {
		signIn();

		const response = await postJson("/share", {
			...note,
			summaryMarkdown: "a".repeat(4_000_001),
		});

		expect(response.status).toBe(413);
		expect(mocks.shareUpsert).not.toHaveBeenCalled();
	});

	it.each([
		["no_organization", 403, "no_valid_org"],
		["conflict", 409, "conflict"],
	])("answers %s without a link", async (result, status, error) => {
		signIn();
		mocks.shareUpsert.mockResolvedValue(result);

		const response = await postJson("/share", note);

		expect(response.status).toBe(status);
		expect(await response.json()).toEqual({ error });
	});

	it("keeps note text out of the response and the logs when saving fails", async () => {
		signIn();
		mocks.shareUpsert.mockRejectedValue(new Error(`insert failed: ${SECRET}`));

		const response = await postJson("/share", note);

		expect(response.status).toBe(500);
		expect(await response.text()).not.toContain(SECRET);
		const logged = JSON.stringify(
			[console.log, console.error, console.warn].flatMap(
				(log) => vi.mocked(log).mock.calls,
			),
		);
		expect(logged).not.toContain(SECRET);
	});

	it("limits how often one account can share", async () => {
		signIn();
		mocks.shareUpsert.mockResolvedValue(saved);
		for (let index = 0; index < 120; index++)
			expect((await postJson("/share", note)).status).toBe(200);

		const limited = await postJson("/share", note);

		expect(limited.status).toBe(429);
		expect(limited.headers.get("retry-after")).not.toBeNull();
		expect(mocks.shareUpsert).toHaveBeenCalledTimes(120);
	});

	it("charges a large note more of the same allowance", async () => {
		signIn();
		mocks.shareUpsert.mockResolvedValue(saved);
		const large = {
			...note,
			transcript: Array.from({ length: 47 }, () => ({
				speaker: "Sam",
				startMs: 0,
				text: "a".repeat(20_000),
			})),
		};
		for (let index = 0; index < 12; index++)
			expect((await postJson("/share", large)).status).toBe(200);

		expect((await postJson("/share", large)).status).toBe(429);
	});

	it("stops sharing a document", async () => {
		const user = signIn();
		mocks.shareDelete.mockResolvedValue(true);

		const response = await call("/share/doc_weekly-sync", {
			method: "DELETE",
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ deleted: true });
		expect(mocks.shareDelete).toHaveBeenCalledWith(
			expect.objectContaining({ id: user.id }),
			"doc_weekly-sync",
		);
	});

	it("answers a document that is not shared without an error", async () => {
		signIn();
		mocks.shareDelete.mockResolvedValue(false);

		const response = await call("/share/doc_unknown", { method: "DELETE" });

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ deleted: false });
	});

	it("rejects a document id it cannot have issued", async () => {
		signIn();

		const response = await call(`/share/${"a".repeat(65)}`, {
			method: "DELETE",
		});

		expect(response.status).toBe(400);
		expect(mocks.shareDelete).not.toHaveBeenCalled();
	});
});
