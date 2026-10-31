import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { CapRecorder } from "../src/index";

class Track {
	readyState = "live";
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
	onerror: ((event: Event) => void) | null = null;
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
		this.ondataavailable?.({ data: new Blob(["partial bytes"]) });
	}
	pause() {
		this.state = "paused";
	}
	stop() {
		this.state = "inactive";
	}
	fail(error?: Error) {
		this.state = "inactive";
		const event = new Event("error");
		if (error) Object.defineProperty(event, "error", { value: error });
		this.onerror?.(event);
		this.ondataavailable?.({ data: new Blob(["final partial bytes"]) });
		this.onstop?.();
	}
}

const descriptors = ["navigator", "MediaStream", "MediaRecorder", "fetch"].map(
	(name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
);
let tracks: Track[];
const requests = mock(async () => {
	throw new Error("An encoder failure must not upload partial recordings");
});

beforeEach(() => {
	tracks = [new Track("video"), new Track("audio")];
	requests.mockClear();
	for (const [name, value] of Object.entries({
		MediaStream: Stream,
		MediaRecorder: Encoder,
		navigator: {
			mediaDevices: {
				getUserMedia: async (constraints: MediaStreamConstraints) =>
					new Stream(
						tracks.filter(
							(track) => track.kind === (constraints.video ? "video" : "audio"),
						),
					),
			},
		},
		fetch: requests,
	})) {
		Object.defineProperty(globalThis, name, { configurable: true, value });
	}
});

afterEach(() => {
	mock.restore();
	for (const [name, descriptor] of descriptors) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
});

test.each(["recording", "paused"] as const)(
	"an encoder error releases capture and timers while %s",
	async (phase) => {
		const intervals = spyOn(globalThis, "setInterval");
		const timeouts = spyOn(globalThis, "setTimeout");
		const clearIntervalSpy = spyOn(globalThis, "clearInterval");
		const clearTimeoutSpy = spyOn(globalThis, "clearTimeout");
		const recorder = new CapRecorder({ publicKey: "fixture", mode: "camera" });
		const errors: Error[] = [];
		recorder.on("error", ({ error }) => errors.push(error));
		const failure = new DOMException(
			"Encoder ran out of memory",
			"UnknownError",
		);
		try {
			await recorder.start();
			const interval = intervals.mock.results.at(-1)?.value;
			const timeout = timeouts.mock.results.at(-1)?.value;
			if (phase === "paused") recorder.pause();
			Encoder.latest.fail(failure);
			expect(recorder.phase).toBe("error");
			expect(errors).toEqual([failure]);
			expect(tracks.map((track) => track.readyState)).toEqual([
				"ended",
				"ended",
			]);
			expect(clearIntervalSpy).toHaveBeenCalledWith(interval);
			expect(clearTimeoutSpy).toHaveBeenCalledWith(timeout);
			expect(requests).not.toHaveBeenCalled();
		} finally {
			recorder.destroy();
		}
	},
);

test("an encoder error without a native error still reports failure", async () => {
	const recorder = new CapRecorder({ publicKey: "fixture", mode: "camera" });
	const errors: Error[] = [];
	recorder.on("error", ({ error }) => errors.push(error));
	try {
		await recorder.start();
		Encoder.latest.fail();
		expect(recorder.phase).toBe("error");
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toBe("Recording failed");
	} finally {
		recorder.destroy();
	}
});

test("an encoder failure during stop rejects with the original error without uploading", async () => {
	const recorder = new CapRecorder({ publicKey: "fixture", mode: "camera" });
	const errors: Error[] = [];
	recorder.on("error", ({ error }) => errors.push(error));
	try {
		await recorder.start();
		const stopping = recorder.stop().catch((error: unknown) => error);
		const failure = new DOMException(
			"Encoder failed to finish",
			"UnknownError",
		);
		Encoder.latest.fail(failure);
		expect(await stopping).toBe(failure);
		expect(errors).toEqual([failure]);
		expect(recorder.phase).toBe("error");
		expect(requests).not.toHaveBeenCalled();
	} finally {
		recorder.destroy();
	}
});

test.each(["destroy", "error handler"] as const)(
	"late encoder errors cannot affect a replacement started after %s",
	async (replacementTrigger) => {
		const recorder = new CapRecorder({ publicKey: "fixture", mode: "camera" });
		const errors: Error[] = [];
		let replacement: Promise<void> | undefined;
		recorder.on("error", ({ error }) => {
			errors.push(error);
			if (replacementTrigger === "error handler") {
				recorder.destroy();
				replacement = recorder.start();
			}
		});
		try {
			await recorder.start();
			const oldEncoder = Encoder.latest;
			const oldTracks = tracks;
			tracks = [new Track("video"), new Track("audio")];
			if (replacementTrigger === "destroy") {
				recorder.destroy();
				replacement = recorder.start();
			} else {
				oldEncoder.fail(new Error("Original encoder failed"));
				expect(errors).toHaveLength(1);
			}
			await replacement;
			expect(oldTracks.every((track) => track.readyState === "ended")).toBe(
				true,
			);
			oldEncoder.fail(new Error("Late encoder failure"));
			expect(recorder.phase).toBe("recording");
			expect(tracks.every((track) => track.readyState === "live")).toBe(true);
			expect(errors).toHaveLength(replacementTrigger === "destroy" ? 0 : 1);
			expect(requests).not.toHaveBeenCalled();
		} finally {
			recorder.destroy();
		}
	},
);
