// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	display: vi.fn(),
	mic: vi.fn(),
	mixer: vi.fn(),
}));

vi.mock("@cap/recorder-core/capture-streams", () => ({
	acquireCameraStream: vi.fn(),
	acquireCameraWithMicStream: vi.fn(),
	acquireDisplayStream: mocks.display,
	acquireMicStream: mocks.mic,
	createAudioMixer: mocks.mixer,
	getCaptureErrorMessage: (error: Error) => error.message,
}));

import { useCommentRecorder } from "@/app/s/[videoId]/_components/timeline/recording/useCommentRecorder";

class Track extends EventTarget {
	kind: "audio" | "video";
	readyState: MediaStreamTrackState = "live";
	stop = vi.fn(() => {
		this.readyState = "ended";
	});

	constructor(kind: "audio" | "video") {
		super();
		this.kind = kind;
	}

	end() {
		this.readyState = "ended";
		this.dispatchEvent(new Event("ended"));
	}

	getSettings() {
		return {};
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

class Recorder {
	static isTypeSupported = () => true;
	static startError: Error | null = null;

	state: RecordingState = "inactive";
	ondataavailable: ((event: BlobEvent) => void) | null = null;
	onstop: ((event: Event) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	mimeType = "video/webm";

	constructor(private readonly stream: Stream) {}

	start() {
		if (Recorder.startError) throw Recorder.startError;
		if (this.stream.getVideoTracks()[0]?.readyState === "ended") {
			throw new DOMException("The video track ended", "InvalidStateError");
		}
		this.state = "recording";
	}

	stop() {
		this.state = "inactive";
	}
}

const deferred = <T>() => {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
};

describe("comment recorder lifecycle", () => {
	let root: Root;
	let container: HTMLDivElement;
	let recorder: ReturnType<typeof useCommentRecorder>;

	beforeEach(async () => {
		vi.clearAllMocks();
		Recorder.startError = null;
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		vi.stubGlobal("MediaStream", Stream);
		vi.stubGlobal("MediaRecorder", Recorder);
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		function Harness() {
			recorder = useCommentRecorder({
				onFinish: vi.fn(),
				selectedCameraId: null,
				selectedMicId: "mic",
			});
			return null;
		}
		await act(async () => root.render(createElement(Harness)));
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("releases capture when screen sharing ends during microphone setup", async () => {
		const videoTrack = new Track("video");
		const micTrack = new Track("audio");
		const mixedTrack = new Track("audio");
		const displayStream = new Stream([videoTrack]);
		const micStream = new Stream([micTrack]);
		const closeMixer = vi.fn(async () => {});
		const pendingMic = deferred<Stream>();
		const start = vi.spyOn(Recorder.prototype, "start");
		mocks.display.mockResolvedValue(displayStream);
		mocks.mic.mockReturnValue(pendingMic.promise);
		mocks.mixer.mockResolvedValue({
			context: {},
			stream: new Stream([mixedTrack]),
			setMicStream: vi.fn(),
			close: closeMixer,
		});

		let starting!: Promise<void>;
		await act(async () => {
			starting = recorder.startScreen();
			await Promise.resolve();
		});
		expect(recorder.phase).toBe("requesting");

		videoTrack.end();
		await act(async () => {
			pendingMic.resolve(micStream);
			await starting;
		});

		expect(recorder.phase).toBe("idle");
		expect(recorder.error).toBe(
			"The recording source ended before recording could start.",
		);
		expect(start).not.toHaveBeenCalled();
		expect(videoTrack.stop).toHaveBeenCalled();
		expect(micTrack.stop).toHaveBeenCalled();
		expect(mixedTrack.stop).toHaveBeenCalled();
		expect(closeMixer).toHaveBeenCalled();
	});

	it("releases capture when MediaRecorder rejects a live source", async () => {
		const videoTrack = new Track("video");
		mocks.display.mockResolvedValue(new Stream([videoTrack]));
		mocks.mic.mockRejectedValue(new Error("No microphone"));
		Recorder.startError = new DOMException(
			"The recorder could not start",
			"InvalidStateError",
		);

		await act(async () => recorder.startScreen());

		expect(recorder.phase).toBe("idle");
		expect(recorder.error).toBe(
			"Recording couldn't start. Please choose the source again.",
		);
		expect(videoTrack.stop).toHaveBeenCalled();
	});
});
