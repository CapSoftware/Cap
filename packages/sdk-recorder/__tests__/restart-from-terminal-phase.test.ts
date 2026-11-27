import { afterEach, expect, test } from "bun:test";
import { CapRecorder } from "../src/index";
import type { RecorderPhase } from "../src/types";

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
	pause() {
		this.state = "paused";
	}
	resume() {
		this.state = "recording";
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
	["navigator", "MediaStream", "MediaRecorder", "fetch"].map((key) => [
		key,
		Object.getOwnPropertyDescriptor(globalThis, key),
	]),
);

afterEach(() => {
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

function mockCapture(getDisplayMedia: () => Promise<Stream>) {
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: { mediaDevices: { getDisplayMedia } },
	});
	Object.defineProperty(globalThis, "MediaStream", {
		configurable: true,
		value: Stream,
	});
	Object.defineProperty(globalThis, "MediaRecorder", {
		configurable: true,
		value: Encoder,
	});
}

interface SdkApiCalls {
	createdVideos: number;
	aborts: number;
	successfulPartBytes: number[];
}

function mockSdkApi(options?: { failPartUpload?: () => boolean }): SdkApiCalls {
	const calls: SdkApiCalls = {
		createdVideos: 0,
		aborts: 0,
		successfulPartBytes: [],
	};
	Object.defineProperty(globalThis, "fetch", {
		configurable: true,
		value: async (input: string, init?: RequestInit) => {
			if (input.endsWith("/videos/create")) {
				calls.createdVideos += 1;
				return Response.json({
					videoId: `test-video-${calls.createdVideos}`,
					shareUrl: "https://cap.so/s/test-video",
					embedUrl: "https://cap.so/embed/test-video",
				});
			}
			if (input.endsWith("/initiate"))
				return Response.json({ uploadId: "test-upload" });
			if (input.endsWith("/presign-part"))
				return Response.json({ presignedUrl: "https://upload.invalid/part" });
			if (input === "https://upload.invalid/part") {
				if (options?.failPartUpload?.())
					return new Response("boom", { status: 500 });
				calls.successfulPartBytes.push((init?.body as Blob).size);
				return new Response(null, { headers: { ETag: "test-etag" } });
			}
			if (input.endsWith("/abort")) {
				calls.aborts += 1;
				return Response.json({ success: true });
			}
			if (input.endsWith("/complete")) return Response.json({ success: true });
			throw new Error(`Unexpected request: ${input}`);
		},
	});
	return calls;
}

function createRecorder() {
	return new CapRecorder({
		publicKey: "test-only",
		camera: { enabled: false },
		microphone: { enabled: false },
	});
}

test("starts again after capture permission is denied", async () => {
	let denied = true;
	mockCapture(async () => {
		if (denied) throw new DOMException("Permission denied", "NotAllowedError");
		return new Stream([new Track()]);
	});
	mockSdkApi();
	const phases: RecorderPhase[] = [];
	const recorder = createRecorder();
	recorder.on("phasechange", ({ phase }) => phases.push(phase));
	try {
		await expect(recorder.start()).rejects.toThrow();
		expect(recorder.phase).toBe("error");

		denied = false;
		await recorder.start();
		expect(recorder.phase).toBe("recording");

		const result = await recorder.stop();
		expect(result.videoId).toBe("test-video-1");
		expect(phases).toEqual([
			"requesting-permission",
			"error",
			"idle",
			"requesting-permission",
			"recording",
			"stopping",
			"uploading",
			"complete",
		]);
	} finally {
		recorder.destroy();
	}
});

test("starts again after a failed upload without leaking the old capture", async () => {
	let failing = true;
	const tracks: Track[] = [];
	mockCapture(async () => {
		const track = new Track();
		tracks.push(track);
		return new Stream([track]);
	});
	const calls = mockSdkApi({ failPartUpload: () => failing });
	const recorder = createRecorder();
	try {
		await recorder.start();
		await expect(recorder.stop()).rejects.toThrow();
		expect(recorder.phase).toBe("error");
		expect(tracks[0]?.readyState).toBe("ended");
		expect(calls.aborts).toBe(1);

		failing = false;
		await recorder.start();
		expect(recorder.phase).toBe("recording");
		expect(tracks).toHaveLength(2);
		expect(tracks[1]?.readyState).toBe("live");

		const result = await recorder.stop();
		expect(result.videoId).toBe("test-video-2");
		expect(calls.createdVideos).toBe(2);
		expect(calls.successfulPartBytes).toEqual([9]);
	} finally {
		recorder.destroy();
	}
});

test.each(["complete", "error"] as const)(
	"restarting from the %s callback without destroy keeps recording",
	async (event) => {
		const tracks: Track[] = [];
		mockCapture(async () => {
			const track = new Track();
			tracks.push(track);
			return new Stream([track]);
		});
		const calls = mockSdkApi({
			failPartUpload: () => event === "error" && tracks.length === 1,
		});
		const recorder = createRecorder();
		let restart: Promise<void> | undefined;
		recorder.on(event, () => {
			restart = recorder.start();
		});
		try {
			await recorder.start();
			await recorder.stop().catch(() => {});
			expect(restart).toBeDefined();
			await restart;
			expect(recorder.phase).toBe("recording");
			expect(tracks).toHaveLength(2);

			const second = await recorder.stop();
			expect(second.videoId).toBe("test-video-2");
			expect(calls.createdVideos).toBe(2);
		} finally {
			recorder.destroy();
		}
	},
);

test("starts again after a completed recording with fresh state", async () => {
	const tracks: Track[] = [];
	mockCapture(async () => {
		const track = new Track();
		tracks.push(track);
		return new Stream([track]);
	});
	const calls = mockSdkApi();
	const recorder = createRecorder();
	try {
		await recorder.start();
		const first = await recorder.stop();
		expect(first.videoId).toBe("test-video-1");
		expect(recorder.phase).toBe("complete");
		expect(tracks[0]?.readyState).toBe("ended");

		await recorder.start();
		expect(recorder.phase).toBe("recording");
		expect(recorder.videoId).toBeNull();
		expect(recorder.durationMs).toBe(0);
		expect(tracks).toHaveLength(2);
		expect(tracks[1]?.readyState).toBe("live");

		const second = await recorder.stop();
		expect(second.videoId).toBe("test-video-2");
		expect(calls.createdVideos).toBe(2);
	} finally {
		recorder.destroy();
	}
});
