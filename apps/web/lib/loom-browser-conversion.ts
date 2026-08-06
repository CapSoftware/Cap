import type {
	BufferTarget,
	Input as MediaInput,
	Output as MediaOutput,
	StreamTarget,
	StreamTargetChunk,
} from "mediabunny";

type BrowserConversionFeatureKey =
	| "VideoDecoder"
	| "VideoEncoder"
	| "AudioDecoder"
	| "AudioEncoder"
	| "WritableStream";

type BrowserFeatureTarget = {
	isSecureContext?: boolean;
} & Partial<Record<BrowserConversionFeatureKey, unknown>>;

type SaveFilePickerOptions = {
	suggestedName?: string;
	types?: Array<{
		description?: string;
		accept: Record<string, string[]>;
	}>;
};

type BrowserFileHandle = {
	createWritable(): Promise<
		WritableStream<StreamTargetChunk> & {
			abort?: (reason?: unknown) => Promise<void>;
		}
	>;
};

type SaveFilePicker = (
	options?: SaveFilePickerOptions,
) => Promise<BrowserFileHandle>;

type ConversionTarget =
	| {
			kind: "stream";
			target: StreamTarget;
			abort(reason: unknown): Promise<void>;
	  }
	| {
			kind: "buffer";
			target: BufferTarget;
			abort(): Promise<void>;
	  };

export type LoomDashSegment = {
	url: string;
	durationSeconds: number;
};

export type LoomDashRepresentation = {
	type: "audio" | "video";
	id: string;
	bandwidth: number;
	codecs: string;
	mimeType: string;
	width?: number;
	height?: number;
	initUrl: string;
	segments: LoomDashSegment[];
	durationSeconds: number;
};

export type LoomDashManifest = {
	durationSeconds?: number;
	audioRepresentations: LoomDashRepresentation[];
	videoRepresentations: LoomDashRepresentation[];
};

export type LoomBrowserConversionProgress = {
	percent: number;
	processedSeconds: number;
};

export class LoomBrowserConversionError extends Error {
	readonly userMessage: string;

	constructor(userMessage: string, cause?: unknown) {
		super(userMessage, cause === undefined ? undefined : { cause });
		this.name = "LoomBrowserConversionError";
		this.userMessage = userMessage;
	}
}

const REQUIRED_BROWSER_FEATURES: Array<{
	key: BrowserConversionFeatureKey;
	label: string;
}> = [
	{ key: "VideoDecoder", label: "WebCodecs video decoding" },
	{ key: "VideoEncoder", label: "WebCodecs video encoding" },
	{ key: "AudioDecoder", label: "WebCodecs audio decoding" },
	{ key: "AudioEncoder", label: "WebCodecs audio encoding" },
	{ key: "WritableStream", label: "browser file streaming" },
];

const UNSUPPORTED_BROWSER_MESSAGE =
	"Streaming Loom downloads are converted in your browser. Use the latest desktop Chrome or Edge, keep this tab open, and choose a save location when prompted. Safari and Firefox do not currently expose the required media and file APIs.";

const UNREADABLE_STREAM_MESSAGE =
	"This Loom stream could not be read directly by the browser. Try the latest desktop Chrome or Edge. If it still fails, use the Cap Loom importer for this video.";

function getBrowserFeatureTarget(): BrowserFeatureTarget {
	return globalThis as BrowserFeatureTarget;
}

function createAbortError() {
	if (typeof DOMException !== "undefined") {
		return new DOMException("Loom conversion was cancelled.", "AbortError");
	}

	const error = new Error("Loom conversion was cancelled.");
	error.name = "AbortError";
	return error;
}

export function getLoomBrowserConversionSupport(
	target: BrowserFeatureTarget = getBrowserFeatureTarget(),
) {
	const missing: string[] = [];

	if (target.isSecureContext === false) {
		missing.push("a secure HTTPS page");
	}

	for (const feature of REQUIRED_BROWSER_FEATURES) {
		if (typeof target[feature.key] === "undefined") {
			missing.push(feature.label);
		}
	}

	return {
		supported: missing.length === 0,
		missing,
		message: missing.length > 0 ? UNSUPPORTED_BROWSER_MESSAGE : undefined,
	};
}

export function getLoomBrowserConversionErrorMessage(error: unknown) {
	if (error instanceof LoomBrowserConversionError) {
		return error.userMessage;
	}

	if (typeof DOMException !== "undefined" && error instanceof DOMException) {
		if (error.name === "NotAllowedError" || error.name === "SecurityError") {
			return "The browser blocked the save dialog. Open this page directly in the latest desktop Chrome or Edge, then click Download Video again.";
		}
	}

	if (process.env.NODE_ENV !== "production" && error instanceof Error) {
		return `${error.name}: ${error.message}`;
	}

	return undefined;
}

export function isLoomBrowserConversionAbort(error: unknown) {
	const isDomAbort =
		typeof DOMException !== "undefined" &&
		error instanceof DOMException &&
		error.name === "AbortError";

	return (
		isDomAbort ||
		(error instanceof Error &&
			(error.name === "AbortError" || error.name === "ConversionCanceledError"))
	);
}

function getSaveFilePicker(): SaveFilePicker | undefined {
	const target = getBrowserFeatureTarget() as BrowserFeatureTarget & {
		showSaveFilePicker?: unknown;
	};

	if (typeof target.showSaveFilePicker !== "function") {
		return undefined;
	}

	return target.showSaveFilePicker.bind(globalThis) as SaveFilePicker;
}

function isFilePickerBlocked(error: unknown) {
	return (
		typeof DOMException !== "undefined" &&
		error instanceof DOMException &&
		(error.name === "NotAllowedError" || error.name === "SecurityError")
	);
}

function withInheritedQuery(path: string, rootPath: string) {
	try {
		const root = new URL(rootPath);
		const url = new URL(path, root);
		if (!url.search) url.search = root.search;
		return url.toString();
	} catch {
		return path;
	}
}

function isDashManifestUrl(url: string) {
	return (url.split("?")[0] ?? "").toLowerCase().endsWith(".mpd");
}

function parseOptionalNumber(value: string | null) {
	if (!value) return undefined;

	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseIsoDurationSeconds(value: string | null) {
	if (!value) return undefined;

	const match = value.match(
		/^P(?:(\d+(?:\.\d+)?)D)?T?(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/,
	);
	if (!match) return undefined;

	const days = Number(match[1] ?? 0);
	const hours = Number(match[2] ?? 0);
	const minutes = Number(match[3] ?? 0);
	const seconds = Number(match[4] ?? 0);
	const total = days * 86400 + hours * 3600 + minutes * 60 + seconds;

	return Number.isFinite(total) && total > 0 ? total : undefined;
}

function getChildrenByName(element: Element | XMLDocument, name: string) {
	return Array.from(element.childNodes).filter(
		(child): child is Element =>
			child.nodeType === 1 && (child as Element).localName === name,
	);
}

function getFirstChildByName(element: Element, name: string) {
	return getChildrenByName(element, name)[0];
}

function getAdaptationSetType(adaptationSet: Element) {
	const contentType = adaptationSet.getAttribute("contentType");
	if (contentType === "audio" || contentType === "video") return contentType;

	const mimeType = adaptationSet.getAttribute("mimeType") ?? "";
	if (mimeType.startsWith("audio/")) return "audio";
	if (mimeType.startsWith("video/")) return "video";

	return null;
}

function expandDashSegments({
	mediaTemplate,
	segmentTimeline,
	startNumber,
	timescale,
	manifestUrl,
}: {
	mediaTemplate: string;
	segmentTimeline: Element[];
	startNumber: number;
	timescale: number;
	manifestUrl: string;
}) {
	const segments: LoomDashSegment[] = [];
	let segmentNumber = startNumber;

	for (const segment of segmentTimeline) {
		const duration = parseOptionalNumber(segment.getAttribute("d"));
		if (!duration) continue;

		const repeat = parseOptionalNumber(segment.getAttribute("r")) ?? 0;
		for (let index = 0; index <= repeat; index += 1) {
			segments.push({
				url: withInheritedQuery(
					mediaTemplate.replace("$Number$", String(segmentNumber)),
					manifestUrl,
				),
				durationSeconds: duration / timescale,
			});
			segmentNumber += 1;
		}
	}

	return segments;
}

function parseDashRepresentation({
	adaptationSet,
	representation,
	manifestUrl,
	type,
}: {
	adaptationSet: Element;
	representation: Element;
	manifestUrl: string;
	type: "audio" | "video";
}) {
	const template =
		getFirstChildByName(representation, "SegmentTemplate") ??
		getFirstChildByName(adaptationSet, "SegmentTemplate");
	if (!template) return null;

	const initialization = template.getAttribute("initialization");
	const mediaTemplate = template.getAttribute("media");
	if (!initialization || !mediaTemplate) return null;

	const timeline = getFirstChildByName(template, "SegmentTimeline");
	const segmentTimeline = timeline ? getChildrenByName(timeline, "S") : [];
	if (segmentTimeline.length === 0) return null;

	const timescale =
		parseOptionalNumber(template.getAttribute("timescale")) ?? 1;
	const startNumber =
		parseOptionalNumber(template.getAttribute("startNumber")) ?? 1;
	const segments = expandDashSegments({
		mediaTemplate,
		segmentTimeline,
		startNumber,
		timescale,
		manifestUrl,
	});
	if (segments.length === 0) return null;

	const bandwidth = parseOptionalNumber(
		representation.getAttribute("bandwidth"),
	);
	const width = parseOptionalNumber(representation.getAttribute("width"));
	const height = parseOptionalNumber(representation.getAttribute("height"));
	const durationSeconds = segments.reduce(
		(total, segment) => total + segment.durationSeconds,
		0,
	);

	return {
		type,
		id: representation.getAttribute("id") ?? type,
		bandwidth: bandwidth ?? 0,
		codecs:
			representation.getAttribute("codecs") ??
			adaptationSet.getAttribute("codecs") ??
			"",
		mimeType:
			representation.getAttribute("mimeType") ??
			adaptationSet.getAttribute("mimeType") ??
			"",
		width,
		height,
		initUrl: withInheritedQuery(initialization, manifestUrl),
		segments,
		durationSeconds,
	} satisfies LoomDashRepresentation;
}

export function parseLoomDashManifest(
	xml: string,
	manifestUrl: string,
): LoomDashManifest {
	if (typeof DOMParser === "undefined") {
		throw new LoomBrowserConversionError(UNREADABLE_STREAM_MESSAGE);
	}

	const document = new DOMParser().parseFromString(xml, "application/xml");
	if (document.getElementsByTagName("parsererror").length > 0) {
		throw new LoomBrowserConversionError(UNREADABLE_STREAM_MESSAGE);
	}

	const mpd = getChildrenByName(document, "MPD")[0];
	if (!mpd) {
		throw new LoomBrowserConversionError(UNREADABLE_STREAM_MESSAGE);
	}

	const manifest: LoomDashManifest = {
		durationSeconds: parseIsoDurationSeconds(
			mpd.getAttribute("mediaPresentationDuration"),
		),
		audioRepresentations: [],
		videoRepresentations: [],
	};

	for (const period of getChildrenByName(mpd, "Period")) {
		for (const adaptationSet of getChildrenByName(period, "AdaptationSet")) {
			const type = getAdaptationSetType(adaptationSet);
			if (!type) continue;

			for (const representation of getChildrenByName(
				adaptationSet,
				"Representation",
			)) {
				const parsed = parseDashRepresentation({
					adaptationSet,
					representation,
					manifestUrl,
					type,
				});
				if (!parsed) continue;

				if (type === "audio") {
					manifest.audioRepresentations.push(parsed);
				} else {
					manifest.videoRepresentations.push(parsed);
				}
			}
		}
	}

	if (manifest.videoRepresentations.length === 0) {
		throw new LoomBrowserConversionError(UNREADABLE_STREAM_MESSAGE);
	}

	return manifest;
}

function selectVideoRepresentation(representations: LoomDashRepresentation[]) {
	return representations.reduce((best, candidate) => {
		const bestPixels = (best.width ?? 0) * (best.height ?? 0);
		const candidatePixels = (candidate.width ?? 0) * (candidate.height ?? 0);
		if (candidatePixels !== bestPixels) {
			return candidatePixels > bestPixels ? candidate : best;
		}

		return candidate.bandwidth > best.bandwidth ? candidate : best;
	});
}

function selectAudioRepresentation(representations: LoomDashRepresentation[]) {
	if (representations.length === 0) return null;

	return representations.reduce((best, candidate) =>
		candidate.bandwidth > best.bandwidth ? candidate : best,
	);
}

async function fetchCors(input: string, signal?: AbortSignal) {
	const response = await fetch(input, {
		mode: "cors",
		referrerPolicy: "no-referrer",
		signal,
	});

	if (!response.ok) {
		throw new LoomBrowserConversionError(UNREADABLE_STREAM_MESSAGE);
	}

	return response;
}

async function fetchDashManifest(url: string, signal?: AbortSignal) {
	const response = await fetchCors(url, signal);
	const xml = await response.text();
	return parseLoomDashManifest(xml, url);
}

async function fetchDashRepresentationBlob({
	representation,
	signal,
	onResourceLoaded,
}: {
	representation: LoomDashRepresentation;
	signal?: AbortSignal;
	onResourceLoaded: () => void;
}) {
	const resources = [
		representation.initUrl,
		...representation.segments.map((s) => s.url),
	];
	const buffers: Array<ArrayBuffer> = new Array(resources.length);
	let nextIndex = 0;

	const worker = async () => {
		while (nextIndex < resources.length) {
			if (signal?.aborted) throw createAbortError();
			const index = nextIndex;
			nextIndex += 1;

			const resource = resources[index];
			if (!resource) continue;

			const response = await fetchCors(resource, signal);
			buffers[index] = await response.arrayBuffer();
			onResourceLoaded();
		}
	};

	await Promise.all(
		Array.from(
			{ length: Math.min(3, resources.length) },
			async () => await worker(),
		),
	);

	return new Blob(buffers, { type: representation.mimeType || "video/webm" });
}

async function createConversionTarget({
	filename,
	BufferTarget,
	StreamTarget,
}: {
	filename: string;
	BufferTarget: typeof import("mediabunny").BufferTarget;
	StreamTarget: typeof import("mediabunny").StreamTarget;
}): Promise<ConversionTarget> {
	try {
		const saveFilePicker = getSaveFilePicker();
		if (saveFilePicker) {
			const fileHandle = await saveFilePicker({
				suggestedName: filename,
				types: [
					{
						description: "MP4 video",
						accept: { "video/mp4": [".mp4"] },
					},
				],
			});
			const writable = await fileHandle.createWritable();
			return {
				kind: "stream",
				target: new StreamTarget(writable, {
					chunked: true,
					chunkSize: 4 * 1024 * 1024,
				}),
				abort: (reason) => writable.abort?.(reason) ?? Promise.resolve(),
			};
		}
	} catch (error) {
		if (!isFilePickerBlocked(error)) {
			throw error;
		}
	}

	return {
		kind: "buffer",
		target: new BufferTarget(),
		abort: () => Promise.resolve(),
	};
}

function createEmptyMp4Error() {
	return new LoomBrowserConversionError(
		"Browser conversion produced an empty MP4. Please try again in the latest desktop Chrome or Edge.",
	);
}

function getBufferTargetBlob(conversionTarget: ConversionTarget) {
	if (conversionTarget.kind !== "buffer") return undefined;

	const buffer = conversionTarget.target.buffer;
	if (!buffer || buffer.byteLength === 0) {
		throw createEmptyMp4Error();
	}

	return new Blob([buffer], { type: "video/mp4" });
}

async function convertDashWebmManifestToMp4({
	url,
	conversionTarget,
	signal,
	onProgress,
	mediabunny,
}: {
	url: string;
	conversionTarget: ConversionTarget;
	signal?: AbortSignal;
	onProgress?: (progress: LoomBrowserConversionProgress) => void;
	mediabunny: typeof import("mediabunny");
}) {
	let completed = false;
	let videoInput: MediaInput | undefined;
	let audioInput: MediaInput | undefined;
	let output: MediaOutput | undefined;

	try {
		onProgress?.({ percent: 0, processedSeconds: 0 });

		const manifest = await fetchDashManifest(url, signal);
		const videoRepresentation = selectVideoRepresentation(
			manifest.videoRepresentations,
		);
		const audioRepresentation = selectAudioRepresentation(
			manifest.audioRepresentations,
		);
		const totalResources =
			1 +
			videoRepresentation.segments.length +
			(audioRepresentation ? 1 + audioRepresentation.segments.length : 0);
		let loadedResources = 0;
		const handleResourceLoaded = () => {
			loadedResources += 1;
			onProgress?.({
				percent: Math.min(
					35,
					Math.round((loadedResources / totalResources) * 35),
				),
				processedSeconds: 0,
			});
		};

		const [videoBlob, audioBlob] = await Promise.all([
			fetchDashRepresentationBlob({
				representation: videoRepresentation,
				signal,
				onResourceLoaded: handleResourceLoaded,
			}),
			audioRepresentation
				? fetchDashRepresentationBlob({
						representation: audioRepresentation,
						signal,
						onResourceLoaded: handleResourceLoaded,
					})
				: Promise.resolve(null),
		]);

		if (signal?.aborted) throw createAbortError();

		videoInput = new mediabunny.Input({
			source: new mediabunny.BlobSource(videoBlob, {
				maxCacheSize: 16 * 1024 * 1024,
			}),
			formats: [mediabunny.WEBM],
		});
		audioInput = audioBlob
			? new mediabunny.Input({
					source: new mediabunny.BlobSource(audioBlob, {
						maxCacheSize: 8 * 1024 * 1024,
					}),
					formats: [mediabunny.WEBM],
				})
			: undefined;

		const videoTrack = await videoInput.getPrimaryVideoTrack();
		const audioTrack = audioInput
			? await audioInput.getPrimaryAudioTrack()
			: null;
		if (!videoTrack) {
			throw new LoomBrowserConversionError(UNREADABLE_STREAM_MESSAGE);
		}

		output = new mediabunny.Output({
			format: new mediabunny.Mp4OutputFormat({ fastStart: false }),
			target: conversionTarget.target,
		});

		const videoSource = new mediabunny.VideoSampleSource({
			codec: "avc",
			bitrate: mediabunny.QUALITY_HIGH,
			hardwareAcceleration: "prefer-hardware",
			alpha: "discard",
		});
		output.addVideoTrack(videoSource);

		const audioSource = audioTrack
			? new mediabunny.AudioSampleSource({
					codec: "aac",
					bitrate: mediabunny.QUALITY_MEDIUM,
				})
			: null;
		if (audioSource) output.addAudioTrack(audioSource);

		await output.start();

		const totalDuration = Math.max(
			1,
			manifest.durationSeconds ??
				videoRepresentation.durationSeconds ??
				audioRepresentation?.durationSeconds ??
				1,
		);
		let processedVideoSeconds = 0;
		let processedAudioSeconds = audioTrack ? 0 : totalDuration;
		const trackCount = audioTrack ? 2 : 1;
		const updateTranscodeProgress = () => {
			const processedSeconds =
				(processedVideoSeconds + processedAudioSeconds) / trackCount;
			const fraction = Math.min(1, processedSeconds / totalDuration);
			onProgress?.({
				percent: Math.min(99, Math.max(35, Math.round(35 + fraction * 64))),
				processedSeconds,
			});
		};

		const pumpVideo = async () => {
			const sink = new mediabunny.VideoSampleSink(videoTrack);
			try {
				for await (const sample of sink.samples()) {
					if (signal?.aborted) throw createAbortError();
					try {
						await videoSource.add(sample);
						processedVideoSeconds = Math.max(
							processedVideoSeconds,
							sample.timestamp + sample.duration,
						);
						updateTranscodeProgress();
					} finally {
						sample.close();
					}
				}
			} finally {
				videoSource.close();
			}
		};

		const pumpAudio = async () => {
			if (!audioTrack || !audioSource) return;

			const sink = new mediabunny.AudioSampleSink(audioTrack);
			try {
				for await (const sample of sink.samples()) {
					if (signal?.aborted) throw createAbortError();
					try {
						await audioSource.add(sample);
						processedAudioSeconds = Math.max(
							processedAudioSeconds,
							sample.timestamp + sample.duration,
						);
						updateTranscodeProgress();
					} finally {
						sample.close();
					}
				}
			} finally {
				audioSource.close();
			}
		};

		await Promise.all([pumpVideo(), pumpAudio()]);
		await output.finalize();
		completed = true;
		onProgress?.({ percent: 100, processedSeconds: totalDuration });
	} catch (error) {
		if (!completed && output && output.state !== "canceled") {
			await output.cancel().catch(() => undefined);
		}
		throw error;
	} finally {
		videoInput?.dispose();
		audioInput?.dispose();
	}
}

async function assertMp4EncodingSupported(
	canEncodeVideo: typeof import("mediabunny").canEncodeVideo,
	canEncodeAudio: typeof import("mediabunny").canEncodeAudio,
) {
	const [canEncodeAvc, canEncodeAac] = await Promise.all([
		canEncodeVideo("avc").catch(() => false),
		canEncodeAudio("aac").catch(() => false),
	]);

	if (!canEncodeAvc || !canEncodeAac) {
		throw new LoomBrowserConversionError(UNSUPPORTED_BROWSER_MESSAGE);
	}
}

export async function saveLoomStreamAsMp4({
	url,
	filename,
	signal,
	onProgress,
}: {
	url: string;
	filename: string;
	signal?: AbortSignal;
	onProgress?: (progress: LoomBrowserConversionProgress) => void;
}) {
	const support = getLoomBrowserConversionSupport();
	if (!support.supported) {
		throw new LoomBrowserConversionError(
			support.message ?? UNSUPPORTED_BROWSER_MESSAGE,
		);
	}

	if (signal?.aborted) throw createAbortError();

	let completed = false;
	let input: MediaInput | undefined;
	let conversionTarget: ConversionTarget | undefined;
	let conversion:
		| Awaited<ReturnType<typeof import("mediabunny").Conversion.init>>
		| undefined;
	const abortConversion = () => {
		void conversion?.cancel();
	};

	try {
		const mediabunny = await import("mediabunny");
		const {
			ALL_FORMATS,
			Conversion,
			CustomPathedSource,
			Input,
			Mp4OutputFormat,
			Output,
			QUALITY_HIGH,
			QUALITY_MEDIUM,
			StreamTarget,
			BufferTarget,
			UrlSource,
			canEncodeAudio,
			canEncodeVideo,
		} = mediabunny;

		await assertMp4EncodingSupported(canEncodeVideo, canEncodeAudio);

		conversionTarget = await createConversionTarget({
			filename,
			BufferTarget,
			StreamTarget,
		});

		if (isDashManifestUrl(url)) {
			await convertDashWebmManifestToMp4({
				url,
				conversionTarget,
				signal,
				onProgress,
				mediabunny,
			});
			completed = true;
			return getBufferTargetBlob(conversionTarget);
		}

		const fetchFn: typeof fetch = (input, init) =>
			fetch(input, {
				...init,
				mode: "cors",
				referrerPolicy: "no-referrer",
			});

		const source = new CustomPathedSource(url, (request) => {
			const requestUrl = request.isRoot
				? request.path
				: withInheritedQuery(request.path, url);

			return new UrlSource(requestUrl, {
				fetchFn,
				getRetryDelay: (previousAttempts) =>
					previousAttempts < 3 ? 0.5 * 2 ** previousAttempts : null,
				maxCacheSize: 32 * 1024 * 1024,
				parallelism: 2,
				requestInit: {
					mode: "cors",
					referrerPolicy: "no-referrer",
				},
			});
		});
		input = new Input({
			source,
			formats: ALL_FORMATS,
		});

		const output = new Output({
			format: new Mp4OutputFormat({ fastStart: false }),
			target: conversionTarget.target,
		});

		conversion = await Conversion.init({
			input,
			output,
			tracks: "primary",
			video: {
				codec: "avc",
				bitrate: QUALITY_HIGH,
				hardwareAcceleration: "prefer-hardware",
			},
			audio: {
				codec: "aac",
				bitrate: QUALITY_MEDIUM,
			},
			showWarnings: false,
		});

		if (!conversion.isValid) {
			const reasons = conversion.discardedTracks.map((track) => track.reason);
			throw new LoomBrowserConversionError(
				reasons.length > 0
					? `${UNREADABLE_STREAM_MESSAGE} Details: ${reasons.join(", ")}.`
					: UNREADABLE_STREAM_MESSAGE,
			);
		}

		conversion.onProgress = (progress, processedSeconds) => {
			onProgress?.({
				percent: Math.min(100, Math.max(0, Math.round(progress * 100))),
				processedSeconds,
			});
		};

		signal?.addEventListener("abort", abortConversion, { once: true });

		await conversion.execute();
		completed = true;
		onProgress?.({ percent: 100, processedSeconds: 0 });
		return getBufferTargetBlob(conversionTarget);
	} catch (error) {
		if (!completed) {
			await conversion?.output.cancel().catch(() => undefined);
			await conversionTarget?.abort(error).catch(() => undefined);
		}

		if (
			error instanceof LoomBrowserConversionError ||
			isLoomBrowserConversionAbort(error)
		) {
			throw error;
		}

		throw new LoomBrowserConversionError(UNREADABLE_STREAM_MESSAGE, error);
	} finally {
		signal?.removeEventListener("abort", abortConversion);
		input?.dispose();
	}
}
