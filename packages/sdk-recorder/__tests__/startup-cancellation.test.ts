import { afterEach, beforeEach, expect, mock, test } from "bun:test";
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
	static starts = 0;
	state = "inactive";

	static isTypeSupported() {
		return true;
	}

	start() {
		Encoder.starts++;
		this.state = "recording";
	}

	stop() {
		this.state = "inactive";
	}
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const descriptors = [
	"navigator",
	"MediaStream",
	"MediaRecorder",
	"AudioContext",
].map(
	(name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
);

function setGlobal(name: string, value: unknown) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}

beforeEach(() => {
	Encoder.starts = 0;
	setGlobal("MediaStream", Stream);
	setGlobal("MediaRecorder", Encoder);
});

afterEach(() => {
	for (const [name, descriptor] of descriptors) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
});

test("destroy cancels pending camera startup without requesting the microphone", async () => {
	const permission = deferred<Stream>();
	const camera = new Track("video");
	const microphone = new Track("audio");
	const getUserMedia = mock((constraints: MediaStreamConstraints) =>
		constraints.video
			? permission.promise
			: Promise.resolve(new Stream([microphone])),
	);
	setGlobal("navigator", { mediaDevices: { getUserMedia } });
	const recorder = new CapRecorder({ publicKey: "fixture", mode: "camera" });

	try {
		const starting = recorder.start();
		expect(recorder.phase).toBe("requesting-permission");
		recorder.destroy();
		permission.resolve(new Stream([camera]));
		await starting;

		expect(recorder.phase).toBe("idle");
		expect(camera.readyState).toBe("ended");
		expect(getUserMedia).toHaveBeenCalledTimes(1);
		expect(Encoder.starts).toBe(0);
	} finally {
		recorder.destroy();
	}
});

test("destroy releases the screen while microphone permission is pending", async () => {
	const permission = deferred<Stream>();
	const screen = new Track("video");
	const microphone = new Track("audio");
	const getUserMedia = mock(() => permission.promise);
	setGlobal("navigator", {
		mediaDevices: {
			getDisplayMedia: async () => new Stream([screen]),
			getUserMedia,
		},
	});
	const recorder = new CapRecorder({
		publicKey: "fixture",
		camera: { enabled: false },
	});

	try {
		const starting = recorder.start();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(getUserMedia).toHaveBeenCalledTimes(1);
		recorder.destroy();
		const screenAfterDestroy = screen.readyState;
		permission.resolve(new Stream([microphone]));
		await starting;

		expect(screenAfterDestroy).toBe("ended");
		expect(microphone.readyState).toBe("ended");
		expect(recorder.phase).toBe("idle");
		expect(Encoder.starts).toBe(0);
	} finally {
		recorder.destroy();
	}
});

test("destroy releases streams returned before start resumes", async () => {
	const permission = deferred<Stream>();
	const camera = new Track("video");
	setGlobal("navigator", {
		mediaDevices: { getUserMedia: () => permission.promise },
	});
	const recorder = new CapRecorder({
		publicKey: "fixture",
		mode: "camera",
		microphone: { enabled: false },
	});

	try {
		const starting = recorder.start();
		permission.resolve(new Stream([camera]));
		queueMicrotask(() => recorder.destroy());
		await starting;

		expect(recorder.phase).toBe("idle");
		expect(camera.readyState).toBe("ended");
		expect(Encoder.starts).toBe(0);
	} finally {
		recorder.destroy();
	}
});

test.each(["grant", "deny"] as const)(
	"a late screen permission %s cannot change a replacement recording",
	async (outcome) => {
		const permission = deferred<Stream>();
		const oldScreen = new Track("video");
		const newScreen = new Track("video");
		const getDisplayMedia = mock()
			.mockImplementationOnce(() => permission.promise)
			.mockImplementationOnce(async () => new Stream([newScreen]));
		setGlobal("navigator", { mediaDevices: { getDisplayMedia } });
		const recorder = new CapRecorder({
			publicKey: "fixture",
			camera: { enabled: false },
			microphone: { enabled: false },
		});
		const errors = mock(() => {});
		recorder.on("error", errors);

		try {
			const starting = recorder.start().catch((error: unknown) => error);
			recorder.destroy();
			await recorder.start();
			if (outcome === "grant") permission.resolve(new Stream([oldScreen]));
			else permission.reject(new Error("Permission denied"));
			expect(await starting).toBeUndefined();

			expect(recorder.phase).toBe("recording");
			expect(newScreen.readyState).toBe("live");
			if (outcome === "grant") expect(oldScreen.readyState).toBe("ended");
			expect(errors).not.toHaveBeenCalled();
			expect(Encoder.starts).toBe(1);
		} finally {
			recorder.destroy();
		}
	},
);

test.each(["resolve", "reject"] as const)(
	"destroy cancels audio startup when resume later %ss",
	async (outcome) => {
		const startup = deferred<void>();
		const screen = new Track("video");
		const system = new Track("audio");
		const microphone = new Track("audio");
		const mixed = new Track("audio");
		const close = mock(async () => {});
		const resume = mock(() => startup.promise);
		setGlobal("navigator", {
			mediaDevices: {
				getDisplayMedia: async () => new Stream([screen, system]),
				getUserMedia: async () => new Stream([microphone]),
			},
		});
		setGlobal(
			"AudioContext",
			class {
				close = close;
				resume = resume;
				createMediaStreamDestination() {
					return { stream: new Stream([mixed]) };
				}
				createGain() {
					return { gain: { value: 1 }, connect() {} };
				}
				createMediaStreamSource() {
					return { connect() {} };
				}
			},
		);
		const recorder = new CapRecorder({
			publicKey: "fixture",
			camera: { enabled: false },
			systemAudio: true,
		});

		try {
			const starting = recorder.start().catch((error: unknown) => error);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(resume).toHaveBeenCalledTimes(1);
			recorder.destroy();
			for (const track of [screen, system, microphone, mixed]) {
				expect(track.readyState).toBe("ended");
			}
			if (outcome === "resolve") startup.resolve();
			else startup.reject(new Error("Audio context closed"));
			expect(await starting).toBeUndefined();
			expect(recorder.phase).toBe("idle");
			expect(close).toHaveBeenCalledTimes(1);
			expect(Encoder.starts).toBe(0);
		} finally {
			recorder.destroy();
		}
	},
);

test("an error handler can destroy and start a replacement recording", async () => {
	const camera = new Track("video");
	const getDisplayMedia = mock()
		.mockRejectedValueOnce(new Error("Permission failed"))
		.mockResolvedValueOnce(new Stream([camera]));
	setGlobal("navigator", { mediaDevices: { getDisplayMedia } });
	const recorder = new CapRecorder({
		publicKey: "fixture",
		camera: { enabled: false },
		microphone: { enabled: false },
	});
	let replacement: Promise<void> | undefined;
	recorder.on("error", () => {
		recorder.destroy();
		replacement = recorder.start();
	});

	try {
		await expect(recorder.start()).rejects.toThrow("Permission failed");
		await replacement;

		expect(recorder.phase).toBe("recording");
		expect(camera.readyState).toBe("live");
		expect(Encoder.starts).toBe(1);
	} finally {
		recorder.destroy();
	}
});
