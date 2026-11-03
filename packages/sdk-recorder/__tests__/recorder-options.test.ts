import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { CapRecorder } from "../src/index";

class Track {
	readonly kind = "video";
	readyState = "live";
	onended: (() => void) | null = null;
	stop() {
		this.readyState = "ended";
	}
}

class Stream {
	constructor(private tracks: Track[]) {}
	getTracks() {
		return this.tracks;
	}
	getVideoTracks() {
		return this.tracks;
	}
	getAudioTracks() {
		return [];
	}
}

class Encoder {
	static latest: Encoder;
	constructor() {
		Encoder.latest = this;
	}
	state = "inactive";
	ondataavailable: ((event: { data: Blob }) => void) | null = null;
	onstop: (() => void) | null = null;
	static isTypeSupported() {
		return true;
	}
	start() {
		this.state = "recording";
	}
	pause() {
		this.state = "paused";
	}
	stop() {
		if (this.state === "inactive") return;
		this.state = "inactive";
		if (!this.onstop) return;
		this.ondataavailable?.({ data: new Blob(["recording"]) });
		queueMicrotask(this.onstop);
	}
}

const originals = new Map(
	[
		"navigator",
		"MediaStream",
		"MediaRecorder",
		"setTimeout",
		"clearTimeout",
		"fetch",
		"Date",
	].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);

beforeEach(() => {
	const stream = new Stream([new Track()]);
	const globals = {
		navigator: {
			mediaDevices: {
				getUserMedia: async () => stream,
				getDisplayMedia: async () => stream,
			},
		},
		MediaStream: Stream,
		MediaRecorder: Encoder,
	};
	for (const [key, value] of Object.entries(globals)) {
		Object.defineProperty(globalThis, key, { configurable: true, value });
	}
});

test.each(["recording", "paused"] as const)(
	"uploads the duration at stop when %s",
	async (phase) => {
		let now = 0;
		const durations: number[] = [];
		const NativeDate = Date;
		Object.defineProperty(globalThis, "Date", {
			configurable: true,
			value: class extends NativeDate {
				static now() {
					return now;
				}
			},
		});
		Object.defineProperty(globalThis, "fetch", {
			configurable: true,
			value: async (input: string, init?: RequestInit) => {
				if (input.endsWith("/videos/create")) {
					now = 5000;
					return Response.json({
						videoId: "test-video",
						shareUrl: "https://cap.so/s/test-video",
						embedUrl: "https://cap.so/embed/test-video",
					});
				}
				if (input.endsWith("/initiate"))
					return Response.json({ uploadId: "test-upload" });
				if (input.endsWith("/presign-part"))
					return Response.json({ presignedUrl: "https://upload.invalid/part" });
				if (input === "https://upload.invalid/part")
					return new Response(null, { headers: { ETag: "test-etag" } });
				if (input.endsWith("/complete")) {
					const body = JSON.parse(String(init?.body));
					durations.push(body.durationInSecs);
					return Response.json({ success: true });
				}
				throw new Error(`Unexpected request: ${input}`);
			},
		});
		const recorder = new CapRecorder({
			publicKey: "test-only",
			mode: "camera",
			microphone: { enabled: false },
		});
		try {
			await recorder.start();
			now = 1500;
			if (phase === "paused") recorder.pause();
			now = 2000;
			await recorder.stop();
			expect(recorder.durationMs).toBe(phase === "paused" ? 1500 : 2000);
			expect(durations).toEqual([phase === "paused" ? 1.5 : 2]);
		} finally {
			recorder.destroy();
		}
	},
);

afterEach(() => {
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

test.each([
	{ constructorLimit: undefined, startLimit: undefined, expected: 14_400_000 },
	{ constructorLimit: 1500, startLimit: undefined, expected: 1500 },
	{ constructorLimit: 1500, startLimit: 700, expected: 700 },
	{ constructorLimit: 1500, startLimit: 0, expected: 0 },
])("schedules $expected ms for the recording", async (scenario) => {
	const schedule = mock((_callback: () => void, _delay?: number) => 1);
	const globals = {
		setTimeout: schedule,
		clearTimeout: mock(() => {}),
	};
	for (const [key, value] of Object.entries(globals)) {
		Object.defineProperty(globalThis, key, { configurable: true, value });
	}
	const recorder = new CapRecorder({
		publicKey: "test-only",
		mode: "camera",
		microphone: { enabled: false },
		maxDurationMs: scenario.constructorLimit,
	});
	try {
		await recorder.start({ maxDurationMs: scenario.startLimit });
		expect(recorder.phase).toBe("recording");
		expect(schedule.mock.calls).toEqual([
			[expect.any(Function), scenario.expected],
		]);
	} finally {
		recorder.destroy();
	}
});

test.each([
	{ options: {}, expectedBase: "https://cap.so" },
	{
		options: { apiBase: undefined, mode: undefined },
		expectedBase: "https://cap.so",
	},
	{
		options: { apiBase: "https://custom.invalid" },
		expectedBase: "https://custom.invalid",
	},
	{ options: { apiBase: "" }, expectedBase: "" },
])("uploads to '$expectedBase' with options $options", async (scenario) => {
	const requests: string[] = [];
	const fetch = mock(async (input: string) => {
		requests.push(input);
		if (input.endsWith("/videos/create"))
			return Response.json({
				videoId: "test-video",
				s3Key: "test-key",
				shareUrl: "https://cap.so/s/test-video",
				embedUrl: "https://cap.so/embed/test-video",
			});
		if (input.endsWith("/initiate"))
			return Response.json({ uploadId: "test-upload" });
		if (input.endsWith("/presign-part"))
			return Response.json({ presignedUrl: "https://upload.invalid/part" });
		if (input === "https://upload.invalid/part")
			return new Response(null, { headers: { ETag: "test-etag" } });
		if (input.endsWith("/complete")) return Response.json({ success: true });
		throw new Error(`Unexpected request: ${input}`);
	});
	Object.defineProperty(globalThis, "fetch", {
		configurable: true,
		value: fetch,
	});
	const recorder = new CapRecorder({
		publicKey: "test-only",
		microphone: { enabled: false },
		...scenario.options,
	});
	try {
		await recorder.start();
		await recorder.stop();
		expect(recorder.phase).toBe("complete");
		const base = `${scenario.expectedBase}/api/developer/sdk/v1`;
		expect(requests).toEqual([
			`${base}/videos/create`,
			`${base}/upload/multipart/initiate`,
			`${base}/upload/multipart/presign-part`,
			"https://upload.invalid/part",
			`${base}/upload/multipart/complete`,
		]);
	} finally {
		recorder.destroy();
	}
});

test.each([
	{ paused: false, pendingStop: false },
	{ paused: true, pendingStop: false },
	{ paused: false, pendingStop: true },
	{ paused: true, pendingStop: true },
])(
	"saves an ended source with paused=$paused and pendingStop=$pendingStop",
	async ({ paused, pendingStop }) => {
		const requests: string[] = [];
		let uploaded = "";
		const fetch = mock(async (input: string, init?: RequestInit) => {
			requests.push(input);
			if (input.endsWith("/videos/create"))
				return Response.json({
					videoId: "test-video",
					s3Key: "test-key",
					shareUrl: "https://cap.so/s/test-video",
					embedUrl: "https://cap.so/embed/test-video",
				});
			if (input.endsWith("/initiate"))
				return Response.json({ uploadId: "test-upload" });
			if (input.endsWith("/presign-part"))
				return Response.json({ presignedUrl: "https://upload.invalid/part" });
			if (input === "https://upload.invalid/part") {
				uploaded = await new Response(init?.body).text();
				return new Response(null, { headers: { ETag: "test-etag" } });
			}
			if (input.endsWith("/complete")) return Response.json({ success: true });
			throw new Error(`Unexpected request: ${input}`);
		});
		Object.defineProperty(globalThis, "fetch", {
			configurable: true,
			value: fetch,
		});
		const recorder = new CapRecorder({
			publicKey: "fixture",
			mode: "camera",
			microphone: { enabled: false },
		});
		try {
			await recorder.start();
			if (paused) recorder.pause();
			const encoder = Encoder.latest;
			encoder.ondataavailable?.({ data: new Blob(["recording"]) });
			encoder.state = "inactive";
			if (!pendingStop) encoder.onstop?.();
			let settled = false;
			const stopping = recorder.stop().then((result) => {
				settled = true;
				return result;
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(settled).toBe(!pendingStop);
			if (pendingStop) {
				expect(requests).toEqual([]);
				encoder.ondataavailable?.({ data: new Blob(["final"]) });
				encoder.onstop?.();
			}
			expect(await stopping).toEqual({
				videoId: "test-video",
				shareUrl: "https://cap.so/s/test-video",
				embedUrl: "https://cap.so/embed/test-video",
			});
			expect(recorder.phase).toBe("complete");
			expect(requests).toContain("https://upload.invalid/part");
			expect(uploaded).toBe(pendingStop ? "recordingfinal" : "recording");
		} finally {
			recorder.destroy();
		}
	},
);
