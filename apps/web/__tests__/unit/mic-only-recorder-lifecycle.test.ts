// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	mic: vi.fn(),
	importMedia: vi.fn(),
	wrap: vi.fn(),
	push: vi.fn(),
	status: vi.fn(),
	toastError: vi.fn(),
}));

vi.mock("@cap/recorder-core/capture-streams", () => ({
	acquireMicStream: mocks.mic,
}));
vi.mock("@cap/recorder-core/recording-spool", async (original) => ({
	...(await original<object>()),
	canUseRecordingSpool: () => false,
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: mocks.push }),
}));
vi.mock("sonner", () => ({
	toast: {
		info: vi.fn(),
		error: mocks.toastError,
		warning: vi.fn(),
		success: vi.fn(),
	},
}));
vi.mock("@/app/(org)/dashboard/caps/UploadingContext", () => ({
	useUploadingContext: () => ({ setUploadStatus: mocks.status }),
}));
vi.mock("@/app/(org)/dashboard/import/import-media", () => ({
	importMediaFile: mocks.importMedia,
}));
vi.mock("@/lib/audio-to-video", () => ({
	wrapAudioInVideo: mocks.wrap,
}));

import { useMicOnlyRecorder } from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/useMicOnlyRecorder";

class Track extends EventTarget {
	kind = "audio" as const;
	readyState: MediaStreamTrackState = "live";
	stop = vi.fn(() => {
		this.readyState = "ended";
	});
}

class Stream {
	constructor(private readonly tracks: Track[]) {}

	getTracks() {
		return this.tracks;
	}

	getAudioTracks() {
		return this.tracks;
	}
}

class Recorder extends EventTarget {
	static isTypeSupported = () => true;
	static latest: Recorder | null = null;

	state: RecordingState = "inactive";
	ondataavailable: ((event: { data: Blob }) => void) | null = null;
	mimeType = "audio/webm";
	stop = vi.fn(() => {
		this.state = "inactive";
		this.dispatchEvent(new Event("stop"));
	});

	constructor() {
		super();
		Recorder.latest = this;
	}

	start() {
		this.state = "recording";
	}

	failEncoding(chunk: Blob) {
		this.state = "inactive";
		this.ondataavailable?.({ data: chunk });
		this.dispatchEvent(new Event("error"));
		this.dispatchEvent(new Event("stop"));
	}
}

describe("microphone-only recorder lifecycle", () => {
	let root: Root;
	let container: HTMLDivElement;
	let recorder: ReturnType<typeof useMicOnlyRecorder>;
	let track: Track;

	beforeEach(async () => {
		vi.clearAllMocks();
		Recorder.latest = null;
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		vi.stubGlobal("MediaRecorder", Recorder);
		track = new Track();
		mocks.mic.mockResolvedValue(new Stream([track]));
		mocks.wrap.mockImplementation(
			async (audio: File) => new File([audio], "video.mp4"),
		);
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		function Harness() {
			recorder = useMicOnlyRecorder({
				organisationId: "org",
				selectedMicId: "mic",
				quality: { mic: {} } as Parameters<
					typeof useMicOnlyRecorder
				>[0]["quality"],
				isProUser: true,
				editorEnabled: false,
			});
			return null;
		}
		await act(async () => root.render(createElement(Harness)));
		await act(async () => recorder.start());
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		Reflect.deleteProperty(URL, "createObjectURL");
		Reflect.deleteProperty(URL, "revokeObjectURL");
		container.remove();
		vi.unstubAllGlobals();
	});

	it("saves what was recorded when the encoder stops the recorder on its own", async () => {
		const saved = Promise.withResolvers<void>();
		mocks.importMedia.mockImplementation(
			async (options: { onVideoCreated: (id: string) => void }) => {
				options.onVideoCreated("video-1");
				saved.resolve();
				return true;
			},
		);
		expect(recorder.phase).toBe("recording");

		await act(async () => {
			Recorder.latest?.failEncoding(new Blob(["audio"]));
			await saved.promise;
		});

		expect(mocks.wrap).toHaveBeenCalledTimes(1);
		expect((mocks.wrap.mock.calls[0]?.[0] as File).size).toBe(5);
		expect(Recorder.latest?.stop).not.toHaveBeenCalled();
		expect(track.stop).toHaveBeenCalled();
		expect(mocks.toastError).toHaveBeenCalledWith(
			"Your browser stopped the recording. Saving what was recorded.",
		);
		expect(recorder.phase).toBe("completed");
		expect(mocks.push).toHaveBeenCalledWith("/s/video-1");
	});

	it("Stop still finishes when the recorder already stopped itself", async () => {
		mocks.importMedia.mockResolvedValue(false);
		const failed = Promise.withResolvers<void>();
		URL.createObjectURL = (blob: Blob) => {
			failed.resolve();
			return `blob:${blob.size}`;
		};
		URL.revokeObjectURL = () => {};

		await act(async () => {
			Recorder.latest?.failEncoding(new Blob(["partial"]));
			await recorder.stop();
			await failed.promise;
		});

		expect(mocks.wrap).toHaveBeenCalledTimes(1);
		expect(track.stop).toHaveBeenCalled();
		expect(recorder.phase).toBe("error");
		expect(recorder.errorDownload?.fileName).toMatch(/-microphone\.webm$/);
		expect(recorder.errorDownload?.url).toBe("blob:7");
	});

	it("a user stop is not saved twice by the recorder's own stop event", async () => {
		const saved = Promise.withResolvers<void>();
		mocks.importMedia.mockImplementation(
			async (options: { onVideoCreated: (id: string) => void }) => {
				options.onVideoCreated("video-2");
				saved.resolve();
				return true;
			},
		);
		await act(async () => {
			Recorder.latest?.ondataavailable?.({ data: new Blob(["take"]) });
			await recorder.stop();
			await saved.promise;
		});

		expect(Recorder.latest?.stop).toHaveBeenCalledTimes(1);
		expect(mocks.importMedia).toHaveBeenCalledTimes(1);
		expect(mocks.toastError).not.toHaveBeenCalled();
		expect(recorder.phase).toBe("completed");
	});

	it("closing the recorder mid-take releases the mic without saving", async () => {
		await act(async () => root.unmount());

		expect(Recorder.latest?.stop).toHaveBeenCalledTimes(1);
		expect(track.stop).toHaveBeenCalled();
		expect(mocks.wrap).not.toHaveBeenCalled();
		expect(mocks.importMedia).not.toHaveBeenCalled();
	});
});
