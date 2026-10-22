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
	state = "inactive";
	ondataavailable: ((event: { data: Blob }) => void) | null = null;
	onstop: (() => void) | null = null;
	static isTypeSupported() {
		return true;
	}
	start() {
		this.state = "recording";
	}
	stop() {
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
