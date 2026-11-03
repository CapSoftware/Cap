import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { CapRecorder } from "../src/index";
import { MultipartClient } from "../src/upload/multipart-client";

class Track {
	readyState: MediaStreamTrackState = "live";
	onended: (() => void) | null = null;
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
	static latest: Encoder;
	state: RecordingState = "inactive";
	stopGate: Promise<void> | null = null;
	ondataavailable: ((event: { data: Blob }) => void) | null = null;
	onstop: (() => void) | null = null;
	constructor() {
		Encoder.latest = this;
	}
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
		const finish = () => {
			this.ondataavailable?.({ data: new Blob(["final recording bytes"]) });
			this.onstop?.();
		};
		if (this.stopGate) this.stopGate.then(finish);
		else queueMicrotask(finish);
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
					return Response.json({
						presignedUrl: "https://fixture.invalid/part",
					});
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

test.each(["explicit replacement", "source-ended replacement", "destroy only"])(
	"destroy cancels a pending encoder stop: %s",
	async (scenario) => {
		const oldDisplay = new Track("video");
		const oldMicrophone = new Track("audio");
		const display = new Track("video");
		const microphone = new Track("audio");
		const gate = Promise.withResolvers<void>();
		const requests: string[] = [];
		const uploaded: string[] = [];
		const phases: string[] = [];
		const errors: Error[] = [];
		const completed: string[] = [];
		let displayRequests = 0;
		let microphoneRequests = 0;
		for (const [name, value] of Object.entries({
			navigator: {
				mediaDevices: {
					getDisplayMedia: async () =>
						new Stream([displayRequests++ === 0 ? oldDisplay : display]),
					getUserMedia: async () =>
						new Stream([
							microphoneRequests++ === 0 ? oldMicrophone : microphone,
						]),
				},
			},
			fetch: async (input: string, init?: RequestInit) => {
				requests.push(input);
				if (input.endsWith("/videos/create")) {
					return Response.json({
						videoId: "replacement",
						shareUrl: "https://fixture.invalid/s/replacement",
						embedUrl: "https://fixture.invalid/embed/replacement",
					});
				}
				if (input.endsWith("/initiate")) {
					return Response.json({ uploadId: "upload" });
				}
				if (input.endsWith("/presign-part")) {
					return Response.json({
						presignedUrl: "https://fixture.invalid/part",
					});
				}
				if (input === "https://fixture.invalid/part") {
					uploaded.push(await new Response(init?.body).text());
					return new Response(null, { headers: { ETag: "fixture-etag" } });
				}
				if (input.endsWith("/complete")) {
					return Response.json({ success: true });
				}
				throw new Error(`Unexpected request ${input}`);
			},
		})) {
			Object.defineProperty(globalThis, name, { configurable: true, value });
		}
		const recorder = new CapRecorder({
			publicKey: "fixture",
			camera: { enabled: false },
		});
		recorder.on("phasechange", ({ phase }) => phases.push(phase));
		recorder.on("error", ({ error }) => errors.push(error));
		recorder.on("complete", ({ videoId }) => completed.push(videoId));
		let stopping: Promise<unknown> | undefined;
		try {
			await recorder.start();
			Encoder.latest.stopGate = gate.promise;
			if (scenario === "source-ended replacement") oldDisplay.onended?.();
			else stopping = recorder.stop().catch((error: unknown) => error);
			expect(recorder.phase).toBe("stopping");
			expect(requests).toEqual([]);
			recorder.destroy();
			expect(oldDisplay.readyState).toBe("ended");
			expect(oldMicrophone.readyState).toBe("ended");
			if (scenario !== "destroy only") await recorder.start();
			const phasesBeforeFinalData = [...phases];
			gate.resolve();
			await new Promise<void>((resolve) => setImmediate(resolve));
			if (scenario !== "destroy only") {
				expect(display.readyState).toBe("live");
				expect(microphone.readyState).toBe("live");
			}
			expect(recorder.phase).toBe(
				scenario === "destroy only" ? "idle" : "recording",
			);
			expect(phases).toEqual(phasesBeforeFinalData);
			expect(requests).toEqual([]);
			expect(errors).toEqual([]);
			expect(completed).toEqual([]);
			if (stopping) {
				expect(await stopping).toMatchObject({
					name: "AbortError",
					message: "Recording was canceled",
				});
			}
			if (scenario === "destroy only") return;
			oldDisplay.onended?.();
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(recorder.phase).toBe("recording");
			expect(requests).toEqual([]);
			stopping = recorder.stop();
			await expect(stopping).resolves.toMatchObject({ videoId: "replacement" });
			expect(uploaded).toEqual(["recording bytesfinal recording bytes"]);
			expect(completed).toEqual(["replacement"]);
			expect(errors).toEqual([]);
			expect(display.readyState).toBe("ended");
			expect(microphone.readyState).toBe("ended");
			expect(recorder.phase).toBe("complete");
		} finally {
			gate.resolve();
			await stopping?.catch(() => {});
			recorder.destroy();
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	},
);

test.each([
	["create", false],
	["create", true],
	["upload", false],
	["upload", true],
	["complete", false],
	["complete", true],
] as const)(
	"a stale %s response (reject: %s) cannot replace or clean up a restarted recording",
	async (stage, reject) => {
		const oldCamera = new Track("video");
		const camera = new Track("video");
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const phases: string[] = [];
		const errors: Error[] = [];
		const completed: string[] = [];
		let captures = 0;
		let creations = 0;
		const waitForOldResponse = async () => {
			entered.resolve();
			await gate.promise;
			if (reject) throw new TypeError("Fixture request failed");
		};
		for (const [name, value] of Object.entries({
			navigator: {
				mediaDevices: {
					getUserMedia: async () =>
						new Stream([captures++ === 0 ? oldCamera : camera]),
				},
			},
			fetch: async (input: string, init?: RequestInit) => {
				const body =
					init?.body && typeof init.body === "string"
						? JSON.parse(init.body)
						: {};
				if (input.endsWith("/videos/create")) {
					const videoId = creations++ === 0 ? "old" : "replacement";
					if (videoId === "old" && stage === "create")
						await waitForOldResponse();
					return Response.json({
						videoId,
						shareUrl: `https://fixture.invalid/s/${videoId}`,
						embedUrl: `https://fixture.invalid/embed/${videoId}`,
					});
				}
				if (input.endsWith("/initiate"))
					return Response.json({ uploadId: "upload" });
				if (input.endsWith("/presign-part"))
					return Response.json({
						presignedUrl: `https://fixture.invalid/part/${body.videoId}`,
					});
				if (input.startsWith("https://fixture.invalid/part/")) {
					if (input.endsWith("/old") && stage === "upload")
						await waitForOldResponse();
					return new Response(null, { headers: { ETag: "fixture-etag" } });
				}
				if (input.endsWith("/complete")) {
					if (body.videoId === "old" && stage === "complete")
						await waitForOldResponse();
					return Response.json({ success: true });
				}
				if (input.endsWith("/abort")) return Response.json({ success: true });
				throw new Error(`Unexpected request ${input}`);
			},
		}))
			Object.defineProperty(globalThis, name, { configurable: true, value });
		const recorder = new CapRecorder({
			publicKey: "fixture",
			mode: "camera",
			microphone: { enabled: false },
		});
		recorder.on("phasechange", ({ phase }) => phases.push(phase));
		recorder.on("error", ({ error }) => errors.push(error));
		recorder.on("complete", ({ videoId }) => completed.push(videoId));
		let oldStop: Promise<unknown> | undefined;
		try {
			await recorder.start();
			oldStop = recorder.stop().catch((error: unknown) => error);
			await entered.promise;
			recorder.destroy();
			await recorder.start();
			const phasesBeforeResponse = [...phases];
			const videoIdBeforeResponse = recorder.videoId;
			gate.resolve();
			expect(await oldStop).toMatchObject({ name: "AbortError" });
			expect(recorder.phase).toBe("recording");
			expect(recorder.videoId).toBe(videoIdBeforeResponse);
			expect(camera.readyState).toBe("live");
			expect(phases).toEqual(phasesBeforeResponse);
			expect(completed).toEqual([]);
			expect(errors).toEqual([]);
			await expect(recorder.stop()).resolves.toMatchObject({
				videoId: "replacement",
			});
			expect(completed).toEqual(["replacement"]);
			expect(camera.readyState).toBe("ended");
		} finally {
			gate.resolve();
			await oldStop;
			recorder.destroy();
		}
	},
);

test.each(["complete", "error"] as const)(
	"a restart from the %s callback retains its new capture",
	async (event) => {
		const cameras = [new Track("video"), new Track("video")];
		let captures = 0;
		Object.defineProperty(globalThis, "navigator", {
			configurable: true,
			value: {
				mediaDevices: {
					getUserMedia: async () => new Stream([cameras[captures++] as Track]),
				},
			},
		});
		const createVideo = spyOn(
			MultipartClient.prototype,
			"createVideo",
		).mockResolvedValue({
			videoId: "fixture",
			s3Key: "fixture.mp4",
			shareUrl: "https://fixture.invalid/s/fixture",
			embedUrl: "https://fixture.invalid/embed/fixture",
		});
		const uploadBlob = spyOn(MultipartClient.prototype, "uploadBlob");
		if (event === "complete") uploadBlob.mockResolvedValue(undefined);
		else uploadBlob.mockRejectedValue(new Error("Fixture upload failed"));
		const recorder = new CapRecorder({
			publicKey: "fixture",
			mode: "camera",
			microphone: { enabled: false },
		});
		let restart: Promise<void> | undefined;
		recorder.on(event, () => {
			recorder.destroy();
			restart = recorder.start();
		});
		try {
			await recorder.start();
			const stopped = await recorder.stop().catch((error: unknown) => error);
			if (event === "complete")
				expect(stopped).toMatchObject({ videoId: "fixture" });
			else expect(stopped).toBeInstanceOf(Error);
			expect(restart).toBeDefined();
			await restart;
			expect(recorder.phase).toBe("recording");
			expect(cameras[0]?.readyState).toBe("ended");
			expect(cameras[1]?.readyState).toBe("live");
		} finally {
			recorder.destroy();
			createVideo.mockRestore();
			uploadBlob.mockRestore();
		}
	},
);
