import { afterEach, beforeEach, expect, test } from "bun:test";
import { CapRecorder } from "../src/index";

class Track {
	readyState: MediaStreamTrackState = "live";
	constructor(readonly kind: "video" | "audio") {}
	stop() {
		this.readyState = "ended";
	}
}

class Stream {
	constructor(private readonly tracks: Track[]) {}
	getTracks() {
		return this.tracks;
	}
	getVideoTracks() {
		return this.tracks.filter((track) => track.kind === "video");
	}
	getAudioTracks() {
		return this.tracks.filter((track) => track.kind === "audio");
	}
}

class Encoder {
	state: RecordingState = "inactive";
	ondataavailable: ((event: { data: Blob }) => void) | null = null;
	onstop: (() => void) | null = null;
	static isTypeSupported() {
		return true;
	}
	start() {
		this.state = "recording";
		this.ondataavailable?.({ data: new Blob(["recording bytes"]) });
	}
	pause() {
		this.state = "paused";
	}
	stop() {
		if (this.state === "inactive") return;
		this.state = "inactive";
		queueMicrotask(() => {
			this.ondataavailable?.({ data: new Blob(["final recording bytes"]) });
			this.onstop?.();
		});
	}
}

const originals = ["navigator", "MediaStream", "MediaRecorder", "fetch"].map(
	(name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
);

beforeEach(() => {
	for (const [name, value] of Object.entries({
		MediaStream: Stream,
		MediaRecorder: Encoder,
	})) {
		Object.defineProperty(globalThis, name, { configurable: true, value });
	}
});

afterEach(() => {
	for (const [name, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
});

test.each(["recording", "paused", "upload failure"] as const)(
	"releases capture before an upload settles from %s",
	async (scenario) => {
		const camera = new Track("video");
		const microphone = new Track("audio");
		const started = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		let uploaded = "";
		const globals = {
			navigator: {
				mediaDevices: {
					getUserMedia: async (constraints: MediaStreamConstraints) =>
						new Stream([constraints.video ? camera : microphone]),
				},
			},
			fetch: async (input: string, init?: RequestInit) => {
				if (input.endsWith("/videos/create")) {
					started.resolve();
					await gate.promise;
					if (scenario === "upload failure") {
						return new Response("Fixture unavailable", { status: 503 });
					}
					return Response.json({
						videoId: "fixture",
						shareUrl: "https://fixture.invalid/s/fixture",
						embedUrl: "https://fixture.invalid/embed/fixture",
					});
				}
				if (input.endsWith("/initiate")) {
					return Response.json({ uploadId: "upload" });
				}
				if (input.endsWith("/presign-part")) {
					return Response.json({ presignedUrl: "https://fixture.invalid/part" });
				}
				if (input === "https://fixture.invalid/part") {
					uploaded = await new Response(init?.body).text();
					return new Response(null, { headers: { ETag: "fixture-etag" } });
				}
				if (input.endsWith("/complete")) {
					return Response.json({ success: true });
				}
				throw new Error(`Unexpected request ${input}`);
			},
		};
		for (const [name, value] of Object.entries(globals)) {
			Object.defineProperty(globalThis, name, { configurable: true, value });
		}
		const recorder = new CapRecorder({ publicKey: "fixture", mode: "camera" });
		let stopping: ReturnType<CapRecorder["stop"]> | undefined;
		try {
			await recorder.start();
			if (scenario === "paused") recorder.pause();
			stopping = recorder.stop();
			await started.promise;
			expect(recorder.phase).toBe("uploading");
			expect(camera.readyState).toBe("ended");
			expect(microphone.readyState).toBe("ended");
			gate.resolve();
			if (scenario === "upload failure") {
				await expect(stopping).rejects.toThrow("SDK API error (503)");
				expect(recorder.phase).toBe("error");
			} else {
				await expect(stopping).resolves.toMatchObject({ videoId: "fixture" });
				expect(uploaded).toBe("recording bytesfinal recording bytes");
				expect(recorder.phase).toBe("complete");
			}
		} finally {
			gate.resolve();
			await stopping?.catch(() => {});
			recorder.destroy();
		}
	},
);
