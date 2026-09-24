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
	recovered: vi.fn(),
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
		loadRecoveredRecordingSpools: mocks.recovered,
		removeRecoveredRecordingSpoolFromCache: vi.fn(),
		resetRecoveredRecordingSpoolsCache: vi.fn(),
	}),
);

import { MultipartCompletionUncertainError } from "@cap/recorder-core/instant-mp4-uploader";
import { MicrophoneUnavailablePrompt } from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/MicrophoneUnavailablePrompt";
import type { RecordingMode } from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/RecordingModeSelector";
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
	constructor(public stream: Stream) {
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
	let micEnabled: boolean;
	let recordingMode: RecordingMode;
	let systemAudioEnabled: boolean;
	let rerender: () => Promise<void>;

	beforeEach(async () => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		micEnabled = false;
		recordingMode = "camera";
		systemAudioEnabled = false;
		mocks.mic.mockReset();
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
		let objectUrl = 0;
		URL.createObjectURL = vi.fn(() => `blob:recording-${++objectUrl}`);
		mocks.recovered.mockResolvedValue([]);
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
				micEnabled,
				systemAudioEnabled,
				recordingMode,
				selectedCameraId: "camera",
				isProUser: true,
			});
			return recorder.isMicrophoneUnavailable
				? createElement(MicrophoneUnavailablePrompt, {
						onRespond: recorder.respondToMicrophoneFailure,
					})
				: null;
		}
		rerender = async () => {
			await act(async () => root?.render(createElement(Harness)));
		};
		await rerender();
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

	it.each([true, false])(
		"allows a new take while retaining a failed backup (disk: %s)",
		async (disk) => {
			if (!disk)
				mocks.spoolCreate.mockRejectedValueOnce(
					new Error("Storage unavailable"),
				);
			await start();
			mocks.finalize.mockRejectedValueOnce(
				new MultipartCompletionUncertainError(new Error("Lost response")),
			);
			await act(async () => recorder.stopRecording());
			expect(recorder.phase).toBe("error");
			await act(async () => recorder.prepareNewRecording());
			expect(recorder.phase).toBe("idle");
			expect(recorder.canStartRecording).toBe(true);
			const leaving = new Event("beforeunload", { cancelable: true });
			window.dispatchEvent(leaving);
			expect(leaving.defaultPrevented).toBe(!disk);
			expect(spool.dispose).not.toHaveBeenCalled();
			expect(mocks.delete).not.toHaveBeenCalled();
			expect(mocks.uploaders[0]?.cancel).not.toHaveBeenCalled();
			expect(mocks.uploaders[0]?.suspend).toHaveBeenCalledOnce();
			const backup = recorder.recoveredDownloads[0];
			expect(backup).toBeDefined();
			expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(backup?.url);
			const savedBlob = vi
				.mocked(URL.createObjectURL)
				.mock.calls.at(-1)?.[0] as Blob;
			expect(await savedBlob.text()).toBe("firsttail");
			mocks.recovered.mockResolvedValue([
				{
					sessionId: "older",
					createdAt: 0,
					mimeType: "video/webm",
					blob: new Blob(["older"]),
				},
			]);
			await act(async () => vi.advanceTimersByTimeAsync(60_000));
			expect(
				recorder.recoveredDownloads.some((item) => item.id === backup?.id),
			).toBe(true);
			mocks.spoolCreate.mockResolvedValue(makeSpool());
			track = new Track();
			mocks.acquire.mockResolvedValue(new Stream([track]));
			await act(async () => recorder.startRecording());
			expect(recorder.phase).toBe("recording");
			expect(mocks.create).toHaveBeenCalledTimes(2);
			await act(async () => recorder.stopRecording());
		},
	);

	it("keeps an already recovered blob when storage cannot be read again", async () => {
		await start();
		mocks.finalize.mockRejectedValueOnce(new Error("Upload failed"));
		await act(async () => recorder.stopRecording());
		expect(recorder.errorDownload).not.toBeNull();
		spool.recoverBlob.mockRejectedValue(new Error("Storage unavailable"));
		let prepared = false;
		await act(async () => {
			prepared = await recorder.prepareNewRecording();
		});
		expect(prepared).toBe(true);
		expect(recorder.phase).toBe("idle");
		expect(recorder.recoveredDownloads).toHaveLength(1);
		const leaving = new Event("beforeunload", { cancelable: true });
		window.dispatchEvent(leaving);
		expect(leaving.defaultPrevented).toBe(true);
		const savedBlob = vi
			.mocked(URL.createObjectURL)
			.mock.calls.at(-1)?.[0] as Blob;
		expect(await savedBlob.text()).toBe("firsttail");
		expect(spool.dispose).not.toHaveBeenCalled();
	});

	it("reports failed preparation without clearing the failed recording", async () => {
		await start();
		mocks.finalize.mockRejectedValueOnce(new Error("Upload failed"));
		await act(async () => recorder.stopRecording());
		const download = recorder.errorDownload;
		vi.mocked(URL.createObjectURL).mockImplementationOnce(() => {
			throw new Error("No object URL available");
		});
		let prepared = true;
		await act(async () => {
			prepared = await recorder.prepareNewRecording();
		});
		expect(prepared).toBe(false);
		expect(recorder.phase).toBe("error");
		expect(recorder.errorDownload).toBe(download);
		expect(recorder.canRetryUpload).toBe(true);
		expect(spool.dispose).not.toHaveBeenCalled();
	});

	it("does not restore a dismissed download from an earlier in-flight scan", async () => {
		const recovered = {
			sessionId: "old-take",
			createdAt: 0,
			mimeType: "video/webm",
			blob: new Blob(["saved"]),
		};
		mocks.recovered.mockResolvedValue([recovered]);
		await act(async () => vi.advanceTimersByTimeAsync(60_000));
		expect(recorder.recoveredDownloads).toHaveLength(1);
		const scan = deferred<Array<typeof recovered>>();
		mocks.recovered.mockReturnValueOnce(scan.promise);
		await act(async () => vi.advanceTimersByTimeAsync(60_000));
		await act(async () => recorder.dismissRecoveredDownload("old-take"));
		expect(recorder.recoveredDownloads).toHaveLength(0);
		await act(async () => scan.resolve([recovered]));
		expect(recorder.recoveredDownloads).toHaveLength(0);
		expect(URL.createObjectURL).toHaveBeenCalledOnce();
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

	it("preserves the final chunk when unmounted during an in-flight stop", async () => {
		await start();
		const nativeRecorder = Recorder.instances[0];
		if (!nativeRecorder) throw new Error("Missing recorder");
		nativeRecorder.stop = () => {
			nativeRecorder.state = "inactive";
		};
		let stopping: Promise<void> | undefined;
		await act(async () => {
			stopping = recorder.stopRecording();
		});
		expect(nativeRecorder.state).toBe("inactive");
		await act(async () => {
			root?.unmount();
			root = null;
		});
		expect(mocks.uploaders[0]?.suspend).not.toHaveBeenCalled();
		await act(async () => {
			nativeRecorder.chunk("last");
			const event = new Event("stop");
			Object.defineProperty(event, "target", { value: nativeRecorder });
			nativeRecorder.onstop?.(event);
			await stopping;
		});
		expect(await (await spool.recoverBlob())?.text()).toBe("firstlast");
		expect(spool.dispose).not.toHaveBeenCalled();
		expect(mocks.uploaders[0]?.suspend).toHaveBeenCalledOnce();
		expect(mocks.finalize).not.toHaveBeenCalled();
		expect(mocks.open).not.toHaveBeenCalled();
		expect(mocks.delete).not.toHaveBeenCalled();
	});

	const clickMicrophoneChoice = (label: string) => {
		const button = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent === label,
		);
		expect(button).toBeDefined();
		button?.click();
	};

	const startWithUnavailableMicrophone = async () => {
		micEnabled = true;
		await rerender();
		mocks.mic.mockRejectedValueOnce(
			new DOMException("Denied", "NotAllowedError"),
		);
		let starting!: Promise<void>;
		await act(async () => {
			starting = recorder.startRecording();
		});
		expect(recorder.isMicrophoneUnavailable).toBe(true);
		expect(recorder.isSettingUp).toBe(true);
		expect(recorder.canStartRecording).toBe(false);
		expect(Recorder.instances).toHaveLength(0);
		expect(mocks.create).not.toHaveBeenCalled();
		expect(track.stop).not.toHaveBeenCalled();
		expect(document.activeElement?.textContent).toBe("Go back");
		return { starting };
	};

	it.each(["camera", "tab"] as const)(
		"continues the same %s capture only after choosing to record without a microphone",
		async (mode) => {
			recordingMode = mode;
			const { starting } = await startWithUnavailableMicrophone();
			await act(async () => recorder.startRecording());
			expect(mocks.acquire).toHaveBeenCalledOnce();
			await act(async () => {
				clickMicrophoneChoice("Record without microphone");
				await starting;
			});
			expect(recorder.phase).toBe("recording");
			expect(recorder.isMicrophoneUnavailable).toBe(false);
			expect(recorder.hasAudioTrack).toBe(false);
			expect(mocks.acquire).toHaveBeenCalledOnce();
			expect(Recorder.instances[0]?.stream.getVideoTracks()).toEqual([track]);
			await act(async () => recorder.stopRecording());
			expect(recorder.phase).toBe("completed");
			expect(recorder.completedShareUrl).toBe("https://cap.so/s/video");
		},
	);

	it("retains captured system audio when continuing without the microphone", async () => {
		recordingMode = "tab";
		systemAudioEnabled = true;
		const systemAudio = new Track();
		systemAudio.kind = "audio";
		mocks.acquire.mockResolvedValue(new Stream([track, systemAudio]));
		const { starting } = await startWithUnavailableMicrophone();
		await act(async () => {
			clickMicrophoneChoice("Record without microphone");
			await starting;
		});
		expect(recorder.hasAudioTrack).toBe(true);
		expect(Recorder.instances[0]?.stream.getAudioTracks()).toEqual([
			systemAudio,
		]);
		await act(async () => recorder.stopRecording());
		expect(systemAudio.stop).toHaveBeenCalled();
	});

	it("releases capture on Go back and allows retry with a working microphone", async () => {
		const { starting } = await startWithUnavailableMicrophone();
		await act(async () => {
			clickMicrophoneChoice("Go back");
			await starting;
		});
		expect(recorder.phase).toBe("idle");
		expect(recorder.isMicrophoneUnavailable).toBe(false);
		expect(recorder.canStartRecording).toBe(true);
		expect(track.stop).toHaveBeenCalled();
		expect(mocks.create).not.toHaveBeenCalled();
		const mic = new Track();
		mic.kind = "audio";
		mocks.mic.mockResolvedValueOnce(new Stream([mic]));
		mocks.acquire.mockResolvedValueOnce(new Stream([new Track()]));
		await start();
		expect(recorder.hasAudioTrack).toBe(true);
		expect(mocks.mic).toHaveBeenCalledTimes(2);
		await act(async () => recorder.stopRecording());
		expect(mic.stop).toHaveBeenCalled();
	});

	it("cancels the microphone choice when screen sharing ends", async () => {
		recordingMode = "tab";
		const { starting } = await startWithUnavailableMicrophone();
		await act(async () => {
			track.readyState = "ended";
			track.dispatchEvent(new Event("ended"));
			await starting;
		});
		expect(recorder.isMicrophoneUnavailable).toBe(false);
		expect(recorder.canStartRecording).toBe(true);
		expect(Recorder.instances).toHaveLength(0);
		expect(mocks.create).not.toHaveBeenCalled();
	});

	it("settles pending microphone setup and releases capture on unmount", async () => {
		const { starting } = await startWithUnavailableMicrophone();
		await act(async () => {
			root?.unmount();
			root = null;
			await starting;
		});
		expect(track.stop).toHaveBeenCalled();
		expect(Recorder.instances).toHaveLength(0);
		expect(mocks.create).not.toHaveBeenCalled();
	});

	it("ignores a late microphone rejection after unmount", async () => {
		micEnabled = true;
		await rerender();
		let rejectMicrophone!: (error: Error) => void;
		mocks.mic.mockReturnValueOnce(
			new Promise<MediaStream>((_resolve, reject) => {
				rejectMicrophone = reject;
			}),
		);
		let starting!: Promise<void>;
		await act(async () => {
			starting = recorder.startRecording();
		});
		await act(async () => {
			root?.unmount();
			root = null;
			rejectMicrophone(new DOMException("Denied", "NotAllowedError"));
			await starting;
		});
		expect(track.stop).toHaveBeenCalled();
		expect(Recorder.instances).toHaveLength(0);
		expect(mocks.create).not.toHaveBeenCalled();
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
