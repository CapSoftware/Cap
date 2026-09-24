// @vitest-environment jsdom

import { Blob as NodeBlob } from "node:buffer";
import { Exit } from "effect";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	create: vi.fn(),
	delete: vi.fn(),
	acquire: vi.fn(),
	mic: vi.fn(),
	initiate: vi.fn(),
	finalize: vi.fn(),
	open: vi.fn(),
	refresh: vi.fn(),
	status: vi.fn(),
	spoolCreate: vi.fn(),
	pipeline: {
		mode: "streaming-webm",
		mimeType: "video/webm",
		fileExtension: "webm",
	},
	uploaders: [] as Array<{
		options: { onFatalError?: () => void };
		handleChunk: ReturnType<typeof vi.fn>;
		finalize: ReturnType<typeof vi.fn>;
		cancel: ReturnType<typeof vi.fn>;
		suspend: ReturnType<typeof vi.fn>;
	}>,
}));

vi.mock("@cap/recorder-core/capture-streams", () => ({
	acquireCameraStream: mocks.acquire,
	acquireDisplayStream: mocks.acquire,
	acquireMicStream: mocks.mic,
	createAudioMixer: vi.fn(),
	getCaptureErrorMessage: (error: Error) => error.message,
}));
vi.mock("@cap/recorder-core/recorder-utils", async (original) => ({
	...(await original<object>()),
	detectCapabilities: () => ({
		assessed: true,
		hasMediaRecorder: true,
		hasUserMedia: true,
		hasDisplayMedia: true,
	}),
	selectRecordingPipeline: () => mocks.pipeline,
	openShareUrlInNewTab: mocks.open,
}));
vi.mock("@cap/recorder-core/recording-spool", async (original) => ({
	...(await original<object>()),
	canUseRecordingSpool: () => true,
	RecordingSpool: { create: mocks.spoolCreate },
}));
vi.mock("@cap/recorder-core/instant-mp4-uploader", async (original) => ({
	...(await original<object>()),
	initiateMultipartUpload: mocks.initiate,
	InstantRecordingUploader: class {
		handleChunk = vi.fn();
		finalize = mocks.finalize;
		cancel = vi.fn(async () => {});
		suspend = vi.fn();
		getProcessingStarted = () => true;
		constructor(public options: { onFatalError?: () => void }) {
			mocks.uploaders.push(this);
		}
	},
}));
vi.mock("@/lib/EffectRuntime", () => ({
	useRpcClient: () => ({
		VideoInstantCreate: mocks.create,
		VideoDelete: mocks.delete,
	}),
	useEffectMutation: ({
		mutationFn,
	}: {
		mutationFn: (input: unknown) => unknown;
	}) => ({ mutateAsync: mutationFn }),
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ refresh: mocks.refresh }),
}));
vi.mock("sonner", () => ({
	toast: {
		info: vi.fn(),
		error: vi.fn(),
		warning: vi.fn(),
		success: vi.fn(),
		dismiss: vi.fn(),
	},
}));
vi.mock("@/app/(org)/dashboard/caps/UploadingContext", () => ({
	useUploadingContext: () => ({ setUploadStatus: mocks.status }),
}));
vi.mock("@/app/(org)/dashboard/caps/components/sendProgressUpdate", () => ({
	sendProgressUpdate: vi.fn(async () => {}),
}));
vi.mock(
	"@/app/(org)/dashboard/caps/components/web-recorder-dialog/recovered-recording-cache",
	() => ({
		loadRecoveredRecordingSpools: vi.fn(async () => []),
		removeRecoveredRecordingSpoolFromCache: vi.fn(),
		resetRecoveredRecordingSpoolsCache: vi.fn(),
	}),
);

import { MultipartCompletionUncertainError } from "@cap/recorder-core/instant-mp4-uploader";
import { useWebRecorder } from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/useWebRecorder";

class Track extends EventTarget {
	kind = "video";
	readyState = "live";
	stop = vi.fn(() => {
		this.readyState = "ended";
	});
	getSettings = () => ({ width: 1920, height: 1080, frameRate: 30 });
}
class Stream {
	constructor(private tracks: Track[]) {}
	getTracks = () => this.tracks;
	getVideoTracks = () => this.tracks.filter((track) => track.kind === "video");
	getAudioTracks = () => this.tracks.filter((track) => track.kind === "audio");
}
class Recorder extends EventTarget {
	static instances: Recorder[] = [];
	state: RecordingState = "inactive";
	ondataavailable?: (event: BlobEvent) => void;
	onstop?: (event: Event) => void;
	onerror?: (event: Event) => void;
	constructor() {
		super();
		Recorder.instances.push(this);
	}
	start() {
		this.state = "recording";
	}
	requestData() {}
	chunk(text: string) {
		const event = Object.assign(new Event("dataavailable"), {
			data: new Blob([text], { type: mocks.pipeline.mimeType }),
		});
		Object.defineProperty(event, "target", { value: this });
		this.ondataavailable?.(event as BlobEvent);
	}
	stop() {
		this.state = "inactive";
		queueMicrotask(() => {
			this.chunk("tail");
			const event = new Event("stop");
			Object.defineProperty(event, "target", { value: this });
			this.onstop?.(event);
		});
	}
}

const deferred = <T>() => {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
};

const makeSpool = () => {
	const chunks: Blob[] = [];
	return {
		chunks,
		appendChunk: vi.fn(async (chunk: Blob) => {
			chunks.push(chunk);
		}),
		flush: vi.fn(async () => {}),
		recoverBlob: vi.fn(async () =>
			chunks.length
				? new Blob(chunks, { type: mocks.pipeline.mimeType })
				: null,
		),
		touch: vi.fn(async () => {}),
		dispose: vi.fn(async () => {}),
	};
};

describe("web recording upload recovery", () => {
	let root: Root | null;
	let container: HTMLDivElement;
	let recorder: ReturnType<typeof useWebRecorder>;
	let spool: ReturnType<typeof makeSpool>;
	let track: Track;

	beforeEach(async () => {
		vi.clearAllMocks();
		mocks.uploaders.length = 0;
		Recorder.instances = [];
		mocks.pipeline = {
			mode: "streaming-webm",
			mimeType: "video/webm",
			fileExtension: "webm",
		};
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		vi.stubGlobal("Blob", NodeBlob);
		vi.stubGlobal("MediaStream", Stream);
		vi.stubGlobal("MediaRecorder", Recorder);
		URL.createObjectURL = vi.fn(() => "blob:recording");
		URL.revokeObjectURL = vi.fn();
		track = new Track();
		mocks.acquire.mockResolvedValue(new Stream([track]));
		mocks.create.mockResolvedValue(
			Exit.succeed({
				id: "video",
				shareUrl: "https://cap.so/s/video",
				upload: {},
			}),
		);
		mocks.initiate.mockResolvedValue({ uploadId: "upload", provider: "s3" });
		mocks.finalize.mockReset().mockResolvedValue(undefined);
		mocks.open.mockReturnValue(true);
		spool = makeSpool();
		mocks.spoolCreate.mockResolvedValue(spool);
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		function Harness() {
			recorder = useWebRecorder({
				organisationId: "org",
				selectedMicId: "mic",
				micEnabled: false,
				systemAudioEnabled: false,
				recordingMode: "camera",
				selectedCameraId: "camera",
				isProUser: true,
			});
			return null;
		}
		await act(async () => root?.render(createElement(Harness)));
	});

	afterEach(async () => {
		await act(async () => root?.unmount());
		container.remove();
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	const start = async () => {
		await act(async () => recorder.startRecording());
		expect(recorder.phase).toBe("recording");
		Recorder.instances[0]?.chunk("first");
	};

	it.each(["webm", "mp4"])(
		"uploads buffered %s with its final chunk and only deletes backup after acknowledgement",
		async (extension) => {
			mocks.pipeline = {
				mode: "buffered-raw",
				mimeType: `video/${extension}`,
				fileExtension: extension,
			};
			await start();
			expect(mocks.create).toHaveBeenCalledOnce();
			expect(mocks.initiate).not.toHaveBeenCalled();
			const uploaded = deferred<void>();
			mocks.finalize.mockReturnValue(uploaded.promise);
			let stopping: Promise<void>;
			await act(async () => {
				stopping = recorder.stopRecording();
			});
			expect(recorder.phase).toBe("uploading");
			expect(recorder.completedShareUrl).toBe("https://cap.so/s/video");
			expect(spool.dispose).not.toHaveBeenCalled();
			const options = mocks.finalize.mock.calls[0]?.[0] as {
				finalBlob: Blob;
				subpath: string;
			};
			expect(await options.finalBlob.text()).toBe("firsttail");
			expect(options.subpath).toBe(`raw-upload.${extension}`);
			await act(async () => {
				uploaded.resolve();
				await stopping;
			});
			expect(recorder.phase).toBe("completed");
			expect(spool.dispose).toHaveBeenCalledOnce();
			expect(mocks.open).toHaveBeenCalledWith("https://cap.so/s/video");
		},
	);

	it("keeps the recording and same video after failure, including closing the dialog, then retries on reconnect", async () => {
		await start();
		mocks.finalize.mockRejectedValueOnce(new Error("Network failed"));
		await act(async () => recorder.stopRecording());
		expect(recorder.phase).toBe("error");
		expect(recorder.canRetryUpload).toBe(true);
		expect(spool.dispose).not.toHaveBeenCalled();
		expect(mocks.delete).not.toHaveBeenCalled();
		await act(async () => recorder.resetState());
		expect(recorder.phase).toBe("error");
		await act(async () => {
			window.dispatchEvent(new Event("online"));
		});
		expect(recorder.phase).toBe("completed");
		expect(mocks.create).toHaveBeenCalledOnce();
		expect(mocks.initiate).toHaveBeenCalledTimes(2);
		const retried = mocks.finalize.mock.calls[1]?.[0] as { finalBlob: Blob };
		expect(await retried.finalBlob.text()).toBe("firsttail");
		expect(mocks.delete).not.toHaveBeenCalled();
	});

	it("retries uncertain completion using the same upload without replacing or aborting it", async () => {
		await start();
		mocks.finalize.mockRejectedValueOnce(
			new MultipartCompletionUncertainError(),
		);
		await act(async () => recorder.stopRecording());
		expect(recorder.phase).toBe("error");
		await act(async () => {
			window.dispatchEvent(new Event("online"));
		});
		expect(mocks.finalize).toHaveBeenCalledOnce();
		await act(async () => recorder.retryUpload());
		expect(recorder.phase).toBe("completed");
		expect(mocks.initiate).toHaveBeenCalledOnce();
		expect(mocks.uploaders[0]?.cancel).not.toHaveBeenCalled();
		expect(mocks.delete).not.toHaveBeenCalled();
	});

	it("continues capturing to disk after live upload fails, then uploads the complete backup", async () => {
		await start();
		await act(async () => {
			mocks.uploaders[0]?.options.onFatalError?.();
		});
		expect(recorder.phase).toBe("recording");
		expect(track.stop).not.toHaveBeenCalled();
		Recorder.instances[0]?.chunk("offline");
		await act(async () => recorder.stopRecording());
		const options = mocks.finalize.mock.calls[0]?.[0] as { finalBlob: Blob };
		expect(await options.finalBlob.text()).toBe("firstofflinetail");
		expect(recorder.phase).toBe("completed");
	});

	it("prevents duplicate starts and duplicate Stop uploads", async () => {
		await act(async () =>
			Promise.all([recorder.startRecording(), recorder.startRecording()]),
		);
		expect(mocks.acquire).toHaveBeenCalledOnce();
		await act(async () =>
			Promise.all([recorder.stopRecording(), recorder.stopRecording()]),
		);
		expect(mocks.finalize).toHaveBeenCalledOnce();
	});

	it("preserves the backup and remote upload on unmount during completion", async () => {
		await start();
		const uploaded = deferred<void>();
		mocks.finalize.mockReturnValue(uploaded.promise);
		let stopping: Promise<void>;
		await act(async () => {
			stopping = recorder.stopRecording();
		});
		await act(async () => {
			root?.unmount();
			root = null;
		});
		expect(spool.dispose).not.toHaveBeenCalled();
		expect(mocks.uploaders[0]?.cancel).not.toHaveBeenCalled();
		expect(mocks.uploaders[0]?.suspend).toHaveBeenCalledOnce();
		expect(mocks.delete).not.toHaveBeenCalled();
		await act(async () => {
			uploaded.resolve();
			await stopping;
		});
		expect(spool.dispose).not.toHaveBeenCalled();
		expect(mocks.open).not.toHaveBeenCalled();
	});

	it("stops a late camera stream after setup was cancelled", async () => {
		const camera = deferred<Stream>();
		mocks.acquire.mockReturnValue(camera.promise);
		let starting: Promise<void>;
		await act(async () => {
			starting = recorder.startRecording();
		});
		await act(async () => {
			root?.unmount();
			root = null;
		});
		await act(async () => {
			camera.resolve(new Stream([track]));
			await starting;
		});
		expect(track.stop).toHaveBeenCalled();
		expect(Recorder.instances).toHaveLength(0);
		expect(mocks.create).not.toHaveBeenCalled();
	});

	it("restarts capture after deliberately discarding an active take", async () => {
		await start();
		mocks.acquire.mockResolvedValue(new Stream([new Track()]));
		mocks.spoolCreate.mockResolvedValue(makeSpool());
		await act(async () => recorder.restartRecording());
		expect(recorder.phase).toBe("recording");
		expect(Recorder.instances).toHaveLength(2);
		expect(spool.dispose).toHaveBeenCalledOnce();
		expect(mocks.delete).toHaveBeenCalledWith("video");
	});

	it("clears the previous share link when starting the next recording", async () => {
		await start();
		await act(async () => recorder.stopRecording());
		expect(recorder.completedShareUrl).toBe("https://cap.so/s/video");
		mocks.acquire.mockResolvedValue(new Stream([new Track()]));
		mocks.spoolCreate.mockResolvedValue(makeSpool());
		await act(async () => recorder.startRecording());
		expect(recorder.phase).toBe("recording");
		expect(recorder.completedShareUrl).toBeNull();
	});

	it("waits for pending local writes before finalizing", async () => {
		await start();
		const flushed = deferred<void>();
		spool.flush.mockReturnValue(flushed.promise);
		let stopping: Promise<void>;
		await act(async () => {
			stopping = recorder.stopRecording();
		});
		expect(mocks.finalize).not.toHaveBeenCalled();
		await act(async () => {
			flushed.resolve();
			await stopping;
		});
		expect(recorder.phase).toBe("completed");
	});

	it("includes chunks delivered while a failed disk backup moves to memory", async () => {
		mocks.pipeline.mode = "buffered-raw";
		await start();
		const recovered = deferred<Blob>();
		spool.appendChunk.mockRejectedValueOnce(new Error("Quota exceeded"));
		spool.recoverBlob.mockReturnValue(recovered.promise);
		await act(async () => {
			Recorder.instances[0]?.chunk("failed-write");
		});
		Recorder.instances[0]?.chunk("during-recovery");
		let stopping: Promise<void>;
		await act(async () => {
			stopping = recorder.stopRecording();
		});
		expect(mocks.finalize).not.toHaveBeenCalled();
		await act(async () => {
			recovered.resolve(new Blob(["firstfailed-write"]));
			await stopping;
		});
		const options = mocks.finalize.mock.calls[0]?.[0] as { finalBlob: Blob };
		expect(await options.finalBlob.text()).toBe(
			"firstfailed-writeduring-recoverytail",
		);
		expect(recorder.phase).toBe("completed");
	});

	it("retains an unreadable disk backup and refuses to publish only its in-memory tail", async () => {
		mocks.pipeline.mode = "buffered-raw";
		await start();
		spool.appendChunk.mockRejectedValueOnce(new Error("Storage failure"));
		spool.recoverBlob.mockRejectedValue(new Error("Read failure"));
		await act(async () => {
			Recorder.instances[0]?.chunk("failed-write");
		});
		expect(recorder.phase).toBe("error");
		expect(spool.dispose).not.toHaveBeenCalled();
		expect(mocks.finalize).not.toHaveBeenCalled();
		expect(mocks.delete).not.toHaveBeenCalled();
	});

	it("automatically retries a transient failure even when no offline event occurred", async () => {
		vi.useFakeTimers();
		await start();
		mocks.finalize.mockRejectedValueOnce(
			new Error("Temporary gateway failure"),
		);
		await act(async () => recorder.stopRecording());
		expect(recorder.phase).toBe("error");
		await act(async () => vi.advanceTimersByTimeAsync(10_000));
		expect(recorder.phase).toBe("completed");
		expect(mocks.create).toHaveBeenCalledOnce();
	});

	it("protects unsent recordings from accidental page close", async () => {
		await start();
		const event = new Event("beforeunload", { cancelable: true });
		window.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
		await act(async () => recorder.stopRecording());
		const done = new Event("beforeunload", { cancelable: true });
		window.dispatchEvent(done);
		expect(done.defaultPrevented).toBe(false);
	});
});
