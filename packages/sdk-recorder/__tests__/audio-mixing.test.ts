import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
	buildCompositeStream,
	type ManagedStreams,
} from "../src/core/stream-manager";
import { CapRecorder } from "../src/index";

class Track {
	stop = mock(() => {});

	constructor(readonly kind: "audio" | "video") {}
}

class Stream {
	constructor(private readonly tracks: Track[]) {}

	getTracks() {
		return this.tracks;
	}

	getAudioTracks() {
		return this.tracks.filter((track) => track.kind === "audio");
	}

	getVideoTracks() {
		return this.tracks.filter((track) => track.kind === "video");
	}
}

class Mixer {
	static instances: Mixer[] = [];
	readonly inputs: Track[] = [];
	readonly output = new Track("audio");
	readonly destination = { stream: new Stream([this.output]) };
	resume = mock(async () => {});
	close = mock(async () => {});

	constructor() {
		Mixer.instances.push(this);
	}

	createMediaStreamDestination() {
		return this.destination;
	}

	createMediaStreamSource(stream: Stream) {
		return {
			connect: () => {
				this.inputs.push(...stream.getAudioTracks());
			},
		};
	}
}

const globals = ["MediaStream", "AudioContext", "MediaRecorder", "navigator"];
const descriptors = globals.map(
	(name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
);

const setGlobal = (name: string, value: unknown) => {
	Object.defineProperty(globalThis, name, { configurable: true, value });
};

const capture = (systemAudio: boolean, microphone: boolean) => {
	const video = new Track("video");
	const system = new Track("audio");
	const mic = new Track("audio");
	const display = new Stream(systemAudio ? [video, system] : [video]);
	const micStream = microphone ? new Stream([mic]) : null;
	const streams = {
		display,
		camera: null,
		microphone: micStream,
	} as unknown as ManagedStreams;
	setGlobal("navigator", {
		mediaDevices: {
			getDisplayMedia: async () => display,
			getUserMedia: async () => micStream,
		},
	});
	return { streams, video, system, mic };
};

beforeEach(() => {
	Mixer.instances = [];
	setGlobal("MediaStream", Stream);
	setGlobal("AudioContext", Mixer);
});

afterEach(() => {
	for (const [name, descriptor] of descriptors) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
});

test("records both audio sources through one track and releases the mixer", async () => {
	const { video, system, mic } = capture(true, true);
	let input: MediaStream | undefined;
	setGlobal(
		"MediaRecorder",
		class {
			static isTypeSupported() {
				return true;
			}

			state = "recording";

			constructor(stream: MediaStream) {
				input = stream;
			}

			start() {}
			stop() {
				this.state = "inactive";
			}
		},
	);
	const recorder = new CapRecorder({
		publicKey: "test-public-key",
		mode: "tab",
		camera: { enabled: false },
		systemAudio: true,
	});
	try {
		await recorder.start();
		const mixer = Mixer.instances[0];
		expect(recorder.phase).toBe("recording");
		expect(input?.getVideoTracks()).toEqual([video]);
		expect(input?.getAudioTracks()).toEqual([mixer?.output]);
		expect(mixer?.inputs).toEqual([system, mic]);
	} finally {
		recorder.destroy();
	}
	const mixer = Mixer.instances[0];
	expect(video.stop).toHaveBeenCalled();
	expect(system.stop).toHaveBeenCalled();
	expect(mic.stop).toHaveBeenCalled();
	expect(mixer?.output.stop).toHaveBeenCalled();
	expect(mixer?.close).toHaveBeenCalledTimes(1);
});

test.each([
	[false, false],
	[true, false],
	[false, true],
])(
	"preserves direct audio tracks for system=%s microphone=%s",
	async (systemAudio, microphone) => {
		const { streams, video, system, mic } = capture(systemAudio, microphone);
		const composite = await buildCompositeStream(streams);
		expect(composite.getVideoTracks()).toEqual([video]);
		expect(composite.getAudioTracks()).toEqual(
			systemAudio ? [system] : microphone ? [mic] : [],
		);
		expect(Mixer.instances).toHaveLength(0);
	},
);

test.each(["encoder", "audio"] as const)(
	"cleans up both audio sources when %s initialization fails",
	async (failure) => {
		const { video, system, mic } = capture(true, true);
		if (failure === "audio") {
			setGlobal(
				"AudioContext",
				class extends Mixer {
					resume = mock(async () => {
						throw new Error("Audio initialization failed");
					});
				},
			);
		}
		setGlobal(
			"MediaRecorder",
			class {
				static isTypeSupported() {
					return true;
				}

				constructor() {
					throw new Error("Encoder initialization failed");
				}
			},
		);
		const recorder = new CapRecorder({
			publicKey: "test-public-key",
			mode: "tab",
			camera: { enabled: false },
			systemAudio: true,
		});
		await expect(recorder.start()).rejects.toThrow(
			failure === "audio"
				? "Audio initialization failed"
				: "Encoder initialization failed",
		);
		expect(recorder.phase).toBe("error");
		expect(video.stop).toHaveBeenCalled();
		expect(system.stop).toHaveBeenCalled();
		expect(mic.stop).toHaveBeenCalled();
		const mixer = Mixer.instances[0];
		expect(mixer?.output.stop).toHaveBeenCalled();
		expect(mixer?.close).toHaveBeenCalledTimes(1);
	},
);
