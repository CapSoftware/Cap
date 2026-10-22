import { afterEach, expect, mock, test } from "bun:test";
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
	static isTypeSupported() {
		return true;
	}
	start() {
		this.state = "recording";
	}
	stop() {
		this.state = "inactive";
	}
}

const originals = new Map(
	[
		"navigator",
		"MediaStream",
		"MediaRecorder",
		"setTimeout",
		"clearTimeout",
	].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
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
	const stream = new Stream([new Track()]);
	const schedule = mock((_callback: () => void, _delay?: number) => 1);
	const globals = {
		navigator: { mediaDevices: { getUserMedia: async () => stream } },
		MediaStream: Stream,
		MediaRecorder: Encoder,
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
