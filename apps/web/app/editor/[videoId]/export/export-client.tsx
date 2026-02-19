"use client";

import {
	computeRenderSpec,
	normalizeConfigForRender,
	scaleRenderSpec,
} from "@cap/editor-render-spec";
import { composeFrame, EditorRenderer, ImageCache } from "@cap/editor-renderer";
import {
	Button,
	SelectContent,
	SelectItem,
	SelectRoot,
	SelectTrigger,
	SelectValue,
	Switch,
} from "@cap/ui";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type {
	ProjectConfiguration,
	TimelineSegment,
} from "../../types/project-config";
import { getAudioPlaybackGain, getSegmentAudioGain } from "../../utils/audio";
import { resolveBackgroundAssetPath } from "../../utils/backgrounds";
import {
	formatTime,
	getTotalDisplayDuration,
	sourceToDisplayTime,
} from "../../utils/time";

type ExportFormat = "mp4" | "gif";
type ResolutionPreset = "original" | "720p" | "1080p" | "4k" | "custom";
type Mp4Codec = "h264" | "h265";

interface VideoData {
	id: string;
	name: string;
	duration: number;
	width: number;
	height: number;
	fps: number | null;
}

interface ExportClientProps {
	video: VideoData;
	videoUrl: string;
	cameraUrl: string | null;
	projectConfig: ProjectConfiguration;
}

const RESOLUTION_PRESETS: Array<{
	value: Exclude<ResolutionPreset, "custom">;
	label: string;
	width?: number;
	height?: number;
}> = [
	{ value: "original", label: "Original" },
	{ value: "720p", label: "720p", width: 1280, height: 720 },
	{ value: "1080p", label: "1080p", width: 1920, height: 1080 },
	{ value: "4k", label: "4K", width: 3840, height: 2160 },
];

const GIF_FPS_OPTIONS = [
	{ label: "10 FPS", value: 10 },
	{ label: "15 FPS", value: 15 },
	{ label: "20 FPS", value: 20 },
	{ label: "25 FPS", value: 25 },
	{ label: "30 FPS", value: 30 },
] as const;

function clampInt(value: number, min: number, max: number) {
	return Math.max(min, Math.min(max, Math.trunc(value)));
}

function getContainedSize(
	containerWidth: number,
	containerHeight: number,
	contentWidth: number,
	contentHeight: number,
) {
	if (containerWidth <= 0 || containerHeight <= 0) return null;

	const safeContentWidth = contentWidth > 0 ? contentWidth : containerWidth;
	const safeContentHeight = contentHeight > 0 ? contentHeight : containerHeight;
	const aspect = safeContentWidth / safeContentHeight;

	let width = containerWidth;
	let height = width / aspect;
	if (height > containerHeight) {
		height = containerHeight;
		width = height * aspect;
	}

	return {
		width: Math.max(1, Math.floor(width)),
		height: Math.max(1, Math.floor(height)),
	};
}

function downloadBlob(blob: Blob, fileName: string) {
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = fileName;
	link.style.display = "none";
	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type SaveTarget =
	| { kind: "file-handle"; handle: FileSystemFileHandle }
	| { kind: "download" };

async function writeSaveTarget(
	target: SaveTarget,
	blob: Blob,
	fileName: string,
) {
	if (target.kind === "file-handle") {
		const writable = await target.handle.createWritable();
		await writable.write(blob);
		await writable.close();
	} else {
		downloadBlob(blob, fileName);
	}

	const url = URL.createObjectURL(blob);
	window.open(url, "_blank");
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function promptSaveLocation(
	fileName: string,
	format: ExportFormat,
): Promise<SaveTarget | null> {
	const picker = (window as unknown as Record<string, unknown>)
		.showSaveFilePicker as
		| ((opts: unknown) => Promise<FileSystemFileHandle>)
		| undefined;

	if (typeof picker !== "function") {
		return { kind: "download" };
	}

	const accept =
		format === "gif" ? { "image/gif": [".gif"] } : { "video/mp4": [".mp4"] };

	try {
		const handle = await picker({
			suggestedName: fileName,
			types: [
				{
					description: format === "gif" ? "GIF Image" : "MP4 Video",
					accept,
				},
			],
		});
		return { kind: "file-handle", handle };
	} catch (err) {
		if (err instanceof DOMException && err.name === "AbortError") return null;
		throw err;
	}
}

function evenFloor(value: number) {
	const floored = Math.floor(value);
	const even = floored - (floored % 2);
	return Math.max(2, even);
}

function normalizeSegments(
	segments: ReadonlyArray<TimelineSegment> | undefined,
	duration: number,
): TimelineSegment[] {
	const base =
		segments && segments.length > 0
			? segments
			: [{ start: 0, end: duration, timescale: 1 }];

	return base
		.map((seg) => ({
			start: Math.max(0, Math.min(duration, seg.start)),
			end: Math.max(0, Math.min(duration, seg.end)),
			timescale:
				Number.isFinite(seg.timescale) && seg.timescale > 0 ? seg.timescale : 1,
			muted: seg.muted,
		}))
		.filter((seg) => seg.end > seg.start)
		.sort((a, b) => a.start - b.start);
}

function findSegmentAtTime(
	segments: ReadonlyArray<TimelineSegment>,
	time: number,
): TimelineSegment | null {
	for (const segment of segments) {
		if (time >= segment.start && time < segment.end) {
			return segment;
		}
	}
	return null;
}

function findNextSegment(
	segments: ReadonlyArray<TimelineSegment>,
	time: number,
): TimelineSegment | null {
	for (const segment of segments) {
		if (segment.start > time) {
			return segment;
		}
	}
	return null;
}

function pickSupportedMimeType(candidates: string[]): string | null {
	for (const type of candidates) {
		if (MediaRecorder.isTypeSupported(type)) return type;
	}
	return null;
}

function getVideoExtensionFromMimeType(mimeType: string): string {
	if (mimeType.includes("mp4")) return "mp4";
	if (mimeType.includes("webm")) return "webm";
	if (mimeType.includes("quicktime") || mimeType.includes("mov")) return "mov";
	return "webm";
}

async function downloadMp4FromUrl(
	url: string,
	signal: AbortSignal | undefined,
	onProgress: (progress: number) => void,
): Promise<Blob> {
	const response = await fetch(url, {
		cache: "no-store",
		signal,
	});

	if (!response.ok) {
		throw new Error("Failed to download source video");
	}

	const reader = response.body?.getReader();
	if (!reader) {
		onProgress(100);
		return await response.blob();
	}

	const contentLengthHeader = response.headers.get("Content-Length");
	const total = contentLengthHeader ? Number(contentLengthHeader) : null;

	const chunks: ArrayBuffer[] = [];
	let received = 0;
	for (;;) {
		if (signal?.aborted) {
			throw new Error("Export cancelled");
		}
		const { done, value } = await reader.read();
		if (done) break;
		if (value) {
			chunks.push(new Uint8Array(value).buffer);
			received += value.byteLength;
			if (total && Number.isFinite(total) && total > 0) {
				onProgress(Math.min(99, Math.round((received / total) * 100)));
			}
		}
	}

	onProgress(100);
	return new Blob(chunks, { type: "video/mp4" });
}

function waitForVideoEvent(
	el: HTMLVideoElement,
	event: "loadedmetadata" | "loadeddata" | "seeked" | "ended",
	signal: AbortSignal | undefined,
) {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Export cancelled"));
			return;
		}

		if (event === "loadedmetadata" && el.readyState >= 1) {
			resolve();
			return;
		}

		if (event === "loadeddata" && el.readyState >= 2) {
			resolve();
			return;
		}

		if (event === "ended" && el.ended) {
			resolve();
			return;
		}

		const abortHandler = () => {
			cleanup();
			reject(new Error("Export cancelled"));
		};

		const handler = () => {
			cleanup();
			resolve();
		};

		const cleanup = () => {
			el.removeEventListener(event, handler);
			signal?.removeEventListener("abort", abortHandler);
		};

		el.addEventListener(event, handler, { once: true });
		signal?.addEventListener("abort", abortHandler, { once: true });
	});
}

async function seekVideo(
	el: HTMLVideoElement,
	time: number,
	signal: AbortSignal | undefined,
) {
	if (Math.abs(el.currentTime - time) < 0.001) return;

	const done = waitForVideoEvent(el, "seeked", signal);
	el.currentTime = time;
	await done;
}

export function ExportClient({
	video,
	videoUrl,
	cameraUrl,
	projectConfig,
}: ExportClientProps) {
	const router = useRouter();

	const [format, setFormat] = useState<ExportFormat>("mp4");
	const [resolutionPreset, setResolutionPreset] =
		useState<ResolutionPreset>("original");
	const [customWidth, setCustomWidth] = useState<number>(video.width);
	const [customHeight, setCustomHeight] = useState<number>(video.height);
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const [mp4Codec, setMp4Codec] = useState<Mp4Codec>("h264");
	const [stripAudio, setStripAudio] = useState(false);

	const [gifFps, setGifFps] = useState<number>(15);
	const [gifQuality, setGifQuality] = useState<number>(10);
	const [gifMaxWidth, setGifMaxWidth] = useState<number>(640);
	const [gifDithering, setGifDithering] = useState(false);
	const [gifMaxDurationSeconds, setGifMaxDurationSeconds] =
		useState<number>(15);

	const [exporting, setExporting] = useState(false);
	const [exportProgress, setExportProgress] = useState<{
		stage: "idle" | "render" | "download" | "convert" | "gif";
		progress: number;
		message: string | null;
	}>({ stage: "idle", progress: 0, message: null });

	const abortRef = useRef<AbortController | null>(null);

	const [sourceSize, setSourceSize] = useState(() => ({
		width: Math.max(2, video.width),
		height: Math.max(2, video.height),
	}));

	const normalizedConfig = useMemo(
		() => normalizeConfigForRender(projectConfig).config,
		[projectConfig],
	);

	const previewBaseResolution = useMemo(() => {
		if (resolutionPreset === "custom") {
			return {
				width: clampInt(customWidth, 2, 7680),
				height: clampInt(customHeight, 2, 7680),
			};
		}

		const preset = RESOLUTION_PRESETS.find((p) => p.value === resolutionPreset);
		if (!preset) return { width: sourceSize.width, height: sourceSize.height };
		if (preset.value === "original")
			return { width: sourceSize.width, height: sourceSize.height };
		return {
			width: preset.width ?? sourceSize.width,
			height: preset.height ?? sourceSize.height,
		};
	}, [
		resolutionPreset,
		customWidth,
		customHeight,
		sourceSize.width,
		sourceSize.height,
	]);

	const sourceSpec = useMemo(
		() =>
			computeRenderSpec(normalizedConfig, sourceSize.width, sourceSize.height),
		[normalizedConfig, sourceSize.width, sourceSize.height],
	);

	const previewSpec = useMemo(() => sourceSpec, [sourceSpec]);

	const previewSpecRef = useRef(previewSpec);
	previewSpecRef.current = previewSpec;

	const totalDurationSeconds = useMemo(() => {
		const segments = projectConfig.timeline?.segments;
		if (!segments || segments.length === 0) {
			return video.duration;
		}
		return Math.min(video.duration, getTotalDisplayDuration([...segments]));
	}, [projectConfig.timeline?.segments, video.duration]);

	const previewTime = useMemo(() => {
		const end = Math.max(0, totalDurationSeconds - 0.1);
		if (end <= 0) return 0;
		return Math.min(1, end);
	}, [totalDurationSeconds]);

	const previewContainerRef = useRef<HTMLDivElement | null>(null);
	const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
	const previewRendererRef = useRef<EditorRenderer | null>(null);

	const previewVideoRef = useRef<HTMLVideoElement | null>(null);
	const previewCameraRef = useRef<HTMLVideoElement | null>(null);

	const [previewReady, setPreviewReady] = useState(false);

	useEffect(() => {
		const canvas = previewCanvasRef.current;
		if (!canvas) return;

		const renderer = new EditorRenderer({
			canvas,
			spec: previewSpecRef.current,
			resolveBackgroundPath: resolveBackgroundAssetPath,
		});

		previewRendererRef.current = renderer;

		return () => {
			renderer.destroy();
			previewRendererRef.current = null;
		};
	}, []);

	useEffect(() => {
		const renderer = previewRendererRef.current;
		renderer?.updateSpec(previewSpec);
		const container = previewContainerRef.current;
		if (container && renderer) {
			const rect = container.getBoundingClientRect();
			const size = getContainedSize(
				rect.width,
				rect.height,
				previewSpec.outputWidth,
				previewSpec.outputHeight,
			);
			if (size) {
				renderer.resize(size.width, size.height);
			}
		}
		renderer?.render();
	}, [previewSpec]);

	useEffect(() => {
		const videoEl = previewVideoRef.current;
		if (!videoEl) return;

		previewRendererRef.current?.setVideoSource(videoEl);

		const onLoaded = () => {
			if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
				setSourceSize((prev) => {
					const w = videoEl.videoWidth;
					const h = videoEl.videoHeight;
					if (prev.width === w && prev.height === h) return prev;
					return { width: w, height: h };
				});
			}
			setPreviewReady(true);
			previewRendererRef.current?.render();
		};

		videoEl.addEventListener("loadeddata", onLoaded);
		return () => videoEl.removeEventListener("loadeddata", onLoaded);
	}, []);

	useEffect(() => {
		const cameraEl = previewCameraRef.current;
		if (!cameraUrl || !cameraEl) return;

		previewRendererRef.current?.setCameraSource(cameraEl);

		const onLoaded = () => {
			previewRendererRef.current?.render();
		};

		cameraEl.addEventListener("loadeddata", onLoaded);
		return () => cameraEl.removeEventListener("loadeddata", onLoaded);
	}, [cameraUrl]);

	useEffect(() => {
		const container = previewContainerRef.current;
		if (!container) return;

		const observer = new ResizeObserver((entries) => {
			const entry = entries[0];
			if (!entry) return;
			const { width, height } = entry.contentRect;
			const spec = previewSpecRef.current;
			const size = getContainedSize(
				width,
				height,
				spec.outputWidth,
				spec.outputHeight,
			);
			if (size) {
				previewRendererRef.current?.resize(size.width, size.height);
				previewRendererRef.current?.render();
			}
		});

		observer.observe(container);
		return () => observer.disconnect();
	}, []);

	const seekPreviewToTime = useCallback(async () => {
		const videoEl = previewVideoRef.current;
		if (!videoEl) return;

		const seek = (el: HTMLVideoElement, time: number) =>
			new Promise<void>((resolve) => {
				if (Math.abs(el.currentTime - time) < 0.001) {
					resolve();
					return;
				}

				const handler = () => {
					el.removeEventListener("seeked", handler);
					resolve();
				};

				el.addEventListener("seeked", handler);
				el.currentTime = time;
			});

		await seek(videoEl, previewTime);

		const cameraEl = previewCameraRef.current;
		if (cameraUrl && cameraEl) {
			await seek(cameraEl, previewTime);
		}

		previewRendererRef.current?.render();
	}, [previewTime, cameraUrl]);

	useEffect(() => {
		if (!previewReady) return;
		void seekPreviewToTime();
	}, [previewReady, seekPreviewToTime]);

	const effectiveResize = useMemo(() => {
		if (resolutionPreset === "original") return null;

		const maxWidth =
			resolutionPreset === "custom"
				? clampInt(customWidth, 2, 7680)
				: (RESOLUTION_PRESETS.find((p) => p.value === resolutionPreset)
						?.width ?? previewBaseResolution.width);
		const maxHeight =
			resolutionPreset === "custom"
				? clampInt(customHeight, 2, 7680)
				: (RESOLUTION_PRESETS.find((p) => p.value === resolutionPreset)
						?.height ?? previewBaseResolution.height);

		const sourceWidth = sourceSpec.outputWidth;
		const sourceHeight = sourceSpec.outputHeight;
		const scale = Math.min(1, maxWidth / sourceWidth, maxHeight / sourceHeight);
		if (scale >= 0.999) return null;

		return {
			maxWidth,
			maxHeight,
			scale,
		};
	}, [
		resolutionPreset,
		customWidth,
		customHeight,
		sourceSpec.outputWidth,
		sourceSpec.outputHeight,
		previewBaseResolution.width,
		previewBaseResolution.height,
	]);

	const exportFileName = useMemo(() => {
		const baseRaw = video.name.trim() === "" ? "cap-export" : video.name.trim();
		const base = baseRaw.replaceAll("/", "-").replaceAll("\\", "-");
		if (format === "gif") return `${base}.gif`;
		return `${base}.mp4`;
	}, [video.name, format]);

	const renderLocally = useCallback(async () => {
		const controller = abortRef.current;
		if (!controller) {
			throw new Error("Missing export controller");
		}

		const segments = normalizeSegments(
			projectConfig.timeline?.segments,
			video.duration,
		);
		const firstSegment = segments[0];
		const lastSegment = segments[segments.length - 1];
		if (!firstSegment || !lastSegment) {
			throw new Error("Missing timeline segments");
		}
		const totalDisplayDuration = Math.max(
			0.01,
			getTotalDisplayDuration([...segments]),
		);

		setExportProgress({
			stage: "download",
			progress: 0,
			message: "Downloading source video...",
		});

		const videoBlob = await downloadMp4FromUrl(
			videoUrl,
			controller.signal,
			(progress) => {
				setExportProgress({
					stage: "download",
					progress: Math.min(99, progress),
					message: "Downloading source video...",
				});
			},
		);

		let cameraBlob: Blob | null = null;
		if (cameraUrl) {
			setExportProgress({
				stage: "download",
				progress: 0,
				message: "Downloading camera...",
			});
			cameraBlob = await downloadMp4FromUrl(
				cameraUrl,
				controller.signal,
				(progress) => {
					setExportProgress({
						stage: "download",
						progress: Math.min(99, progress),
						message: "Downloading camera...",
					});
				},
			);
		}

		const videoObjectUrl = URL.createObjectURL(videoBlob);
		const videoEl = document.createElement("video");
		videoEl.src = videoObjectUrl;
		videoEl.preload = "auto";
		videoEl.playsInline = true;

		await waitForVideoEvent(videoEl, "loadedmetadata", controller.signal);
		await waitForVideoEvent(videoEl, "loadeddata", controller.signal);

		let cameraObjectUrl: string | null = null;
		let cameraEl: HTMLVideoElement | null = null;
		if (cameraBlob) {
			cameraObjectUrl = URL.createObjectURL(cameraBlob);
			cameraEl = document.createElement("video");
			cameraEl.src = cameraObjectUrl;
			cameraEl.preload = "auto";
			cameraEl.playsInline = true;
			cameraEl.muted = true;

			await waitForVideoEvent(cameraEl, "loadedmetadata", controller.signal);
			await waitForVideoEvent(cameraEl, "loadeddata", controller.signal);
		}

		const maxWidth = effectiveResize?.maxWidth ?? sourceSpec.outputWidth;
		const maxHeight = effectiveResize?.maxHeight ?? sourceSpec.outputHeight;

		const scaledW = evenFloor(Math.min(sourceSpec.outputWidth, maxWidth));
		const scaledH = evenFloor(Math.min(sourceSpec.outputHeight, maxHeight));

		const scale =
			effectiveResize == null
				? 1
				: Math.min(
						1,
						scaledW / sourceSpec.outputWidth,
						scaledH / sourceSpec.outputHeight,
					);

		const widthA = evenFloor(sourceSpec.outputWidth * scale);
		const heightA = evenFloor(
			sourceSpec.outputHeight * (widthA / sourceSpec.outputWidth),
		);
		const heightB = evenFloor(sourceSpec.outputHeight * scale);
		const widthB = evenFloor(
			sourceSpec.outputWidth * (heightB / sourceSpec.outputHeight),
		);

		const pickA =
			widthA <= maxWidth &&
			heightA <= maxHeight &&
			(widthA * heightA >= widthB * heightB ||
				widthB > maxWidth ||
				heightB > maxHeight);

		const exportWidth = pickA ? widthA : widthB;
		const exportHeight = pickA ? heightA : heightB;

		const canvas = document.createElement("canvas");
		canvas.width = exportWidth;
		canvas.height = exportHeight;
		const ctx = canvas.getContext("2d");
		if (!ctx) {
			throw new Error("Failed to initialize canvas");
		}

		const imageCache = new ImageCache();
		const bg = sourceSpec.backgroundSpec;
		let bgUrl: string | null = null;
		if ((bg.type === "image" || bg.type === "wallpaper") && bg.path) {
			const resolvedBgUrl = resolveBackgroundAssetPath(bg.path);
			bgUrl = resolvedBgUrl;
			await Promise.race([
				new Promise<void>((resolve) =>
					imageCache.preload(resolvedBgUrl, resolve),
				),
				new Promise<void>((resolve) => setTimeout(resolve, 3000)),
			]);
		}

		const includeAudio = !stripAudio;
		if (typeof MediaRecorder === "undefined") {
			throw new Error("Your browser doesn't support MediaRecorder");
		}

		const recorderMime =
			pickSupportedMimeType(
				includeAudio
					? [
							"video/mp4",
							"video/webm;codecs=vp9,opus",
							"video/webm;codecs=vp8,opus",
							"video/webm",
						]
					: [
							"video/mp4",
							"video/webm;codecs=vp9",
							"video/webm;codecs=vp8",
							"video/webm",
						],
			) ?? "";

		if (!recorderMime) {
			throw new Error(
				"None of the media formats are supported by this browser",
			);
		}

		const fps = clampInt(video.fps ?? 60, 1, 60);

		const stream = canvas.captureStream(fps);
		let audioContext: AudioContext | null = null;
		let gainNode: GainNode | null = null;

		if (includeAudio) {
			const AudioContextCtor =
				window.AudioContext ||
				(window as unknown as { webkitAudioContext?: typeof AudioContext })
					.webkitAudioContext;
			if (!AudioContextCtor) {
				throw new Error("Your browser doesn't support audio export");
			}

			audioContext = new AudioContextCtor();
			await audioContext.resume().catch(() => undefined);
			const source = audioContext.createMediaElementSource(videoEl);
			gainNode = audioContext.createGain();
			const outputGain = getAudioPlaybackGain(projectConfig.audio);
			const destination = audioContext.createMediaStreamDestination();
			source.connect(gainNode);
			gainNode.connect(destination);
			gainNode.gain.value = outputGain;
			videoEl.muted = false;
			for (const track of destination.stream.getAudioTracks()) {
				stream.addTrack(track);
			}
		} else {
			videoEl.muted = true;
		}

		const recorder = new MediaRecorder(stream, {
			mimeType: recorderMime,
			videoBitsPerSecond: 5_000_000,
		});

		const chunks: Blob[] = [];
		recorder.ondataavailable = (event) => {
			if (event.data.size > 0) {
				chunks.push(event.data);
			}
		};

		const exportSpec = scaleRenderSpec(sourceSpec, exportWidth);

		let rafId = 0;
		let stopped = false;

		const renderFrame = () => {
			const videoFrame =
				videoEl.readyState >= 2
					? {
							source: videoEl,
							width: videoEl.videoWidth,
							height: videoEl.videoHeight,
						}
					: null;

			const cameraFrame =
				cameraEl && cameraEl.readyState >= 2
					? {
							source: cameraEl,
							width: cameraEl.videoWidth,
							height: cameraEl.videoHeight,
						}
					: null;

			let bgImage: unknown = null;
			let bgImageWidth = 0;
			let bgImageHeight = 0;

			if (bgUrl) {
				const img = imageCache.get(bgUrl);
				if (img) {
					bgImage = img;
					bgImageWidth = img.naturalWidth;
					bgImageHeight = img.naturalHeight;
				}
			}

			composeFrame(
				ctx,
				exportSpec,
				videoFrame,
				bgImage,
				bgImageWidth,
				bgImageHeight,
				cameraFrame,
			);
		};

		const stopAll = () => {
			if (stopped) return;
			stopped = true;

			if (rafId) {
				cancelAnimationFrame(rafId);
				rafId = 0;
			}

			videoEl.pause();
			cameraEl?.pause();

			try {
				if (recorder.state === "recording") {
					recorder.stop();
				}
			} catch {}
		};

		controller.signal.addEventListener("abort", stopAll, { once: true });

		await seekVideo(videoEl, firstSegment.start, controller.signal);
		if (cameraEl) {
			await seekVideo(cameraEl, firstSegment.start, controller.signal).catch(
				() => undefined,
			);
		}

		const applySegmentSettings = (segment: TimelineSegment) => {
			const rate = Math.max(0.1, Math.min(16, segment.timescale));
			videoEl.playbackRate = rate;
			if (cameraEl) cameraEl.playbackRate = rate;

			if (gainNode && audioContext) {
				const segGain = getSegmentAudioGain(projectConfig.audio, segment);
				gainNode.gain.setValueAtTime(segGain, audioContext.currentTime);
			}
		};

		const syncCamera = (time: number) => {
			if (!cameraEl) return;
			if (Math.abs(cameraEl.currentTime - time) > 0.1) {
				cameraEl.currentTime = time;
			}
		};

		setExportProgress({
			stage: "render",
			progress: 0,
			message: "Rendering locally...",
		});

		renderFrame();
		recorder.start(1000);

		applySegmentSettings(firstSegment);

		await videoEl.play().catch(() => {
			throw new Error("Failed to play source video");
		});
		if (cameraEl) {
			await cameraEl.play().catch(() => undefined);
		}

		const recorded = new Promise<{ blob: Blob; mimeType: string }>(
			(resolve, reject) => {
				recorder.onstop = () => {
					resolve({
						blob: new Blob(chunks, { type: recorderMime.split(";")[0] }),
						mimeType: recorderMime,
					});
				};
				recorder.onerror = () => {
					reject(new Error("Export failed"));
				};
			},
		);

		const step = () => {
			if (controller.signal.aborted || stopped) return;

			if (videoEl.ended) {
				stopAll();
				return;
			}

			const currentTime = videoEl.currentTime;
			const segment = findSegmentAtTime(segments, currentTime);

			if (!segment) {
				const next = findNextSegment(segments, currentTime);
				if (!next) {
					stopAll();
					return;
				}
				videoEl.currentTime = next.start;
				syncCamera(next.start);
				applySegmentSettings(next);
			} else {
				if (currentTime >= segment.end) {
					const next = findNextSegment(segments, currentTime);
					if (!next) {
						stopAll();
						return;
					}
					videoEl.currentTime = next.start;
					syncCamera(next.start);
					applySegmentSettings(next);
				} else {
					applySegmentSettings(segment);
				}
			}

			syncCamera(videoEl.currentTime);

			renderFrame();

			const displayTime = sourceToDisplayTime(videoEl.currentTime, segments);
			const progress = Math.min(
				99,
				Math.round((displayTime / totalDisplayDuration) * 100),
			);
			setExportProgress({
				stage: "render",
				progress,
				message: "Rendering locally...",
			});

			if (videoEl.currentTime >= lastSegment.end) {
				stopAll();
				return;
			}

			rafId = requestAnimationFrame(step);
		};

		rafId = requestAnimationFrame(step);

		try {
			const result = await recorded;
			return result;
		} finally {
			stopAll();
			imageCache.clear();
			await audioContext?.close().catch(() => undefined);
			controller.signal.removeEventListener("abort", stopAll);
			URL.revokeObjectURL(videoObjectUrl);
			if (cameraObjectUrl) {
				URL.revokeObjectURL(cameraObjectUrl);
			}
		}
	}, [
		cameraUrl,
		effectiveResize,
		projectConfig.timeline?.segments,
		projectConfig.audio,
		sourceSpec,
		stripAudio,
		video.duration,
		video.fps,
		videoUrl,
	]);

	const convertMp4IfNeeded = useCallback(
		async (input: Blob): Promise<Blob> => {
			const needsConvert = input.type !== "video/mp4" || mp4Codec !== "h264";
			if (!needsConvert) return input;

			const canUseWebCodecs =
				typeof VideoDecoder !== "undefined" &&
				typeof AudioDecoder !== "undefined" &&
				typeof ArrayBuffer.prototype.resize === "function";
			if (!canUseWebCodecs) {
				throw new Error(
					"Your browser doesn't support WebCodecs. Try using Chrome or Edge.",
				);
			}

			const webcodecs = await import("@remotion/webcodecs");

			const controller = webcodecs.webcodecsController();
			const abortListener = () => controller.abort("Export cancelled");
			abortRef.current?.signal.addEventListener("abort", abortListener, {
				once: true,
			});

			setExportProgress({
				stage: "convert",
				progress: 0,
				message: "Converting...",
			});

			const file = new File(
				[input],
				`cap-export.${getVideoExtensionFromMimeType(input.type)}`,
				{
					type: input.type || "video/webm",
				},
			);

			const result = await webcodecs.convertMedia({
				src: file,
				container: "mp4",
				videoCodec: mp4Codec,
				onAudioTrack: ({ canCopyTrack, defaultAudioCodec, track }) => {
					if (stripAudio) return { type: "drop" as const };
					if (canCopyTrack) return { type: "copy" as const };

					const sampleRate =
						typeof track.sampleRate === "number" ? track.sampleRate : null;
					return {
						type: "reencode" as const,
						audioCodec: defaultAudioCodec ?? "aac",
						bitrate: 128_000,
						sampleRate,
					};
				},
				onProgress: ({ overallProgress }) => {
					if (overallProgress !== null) {
						setExportProgress({
							stage: "convert",
							progress: Math.min(99, Math.round(overallProgress * 100)),
							message: "Converting...",
						});
					}
				},
				controller,
			});

			const blob = await result.save();
			setExportProgress({ stage: "convert", progress: 100, message: "Ready" });
			return blob;
		},
		[mp4Codec, stripAudio],
	);

	const exportGifFromMp4 = useCallback(
		async (input: Blob): Promise<Blob> => {
			setExportProgress({
				stage: "gif",
				progress: 0,
				message: "Preparing GIF...",
			});

			const GifModule = await import("gif.js");
			const GIF = GifModule.default;

			const videoElement = document.createElement("video");
			videoElement.muted = true;
			videoElement.playsInline = true;
			videoElement.src = URL.createObjectURL(input);

			await new Promise<void>((resolve) => {
				videoElement.onloadedmetadata = () => resolve();
			});

			const sourceWidth = videoElement.videoWidth || sourceSpec.outputWidth;
			const sourceHeight = videoElement.videoHeight || sourceSpec.outputHeight;

			const maxWidth = clampInt(gifMaxWidth, 120, 2000);
			const maxHeight = clampInt(
				Math.round((maxWidth / sourceWidth) * sourceHeight),
				120,
				2000,
			);
			const scale = Math.min(
				1,
				maxWidth / sourceWidth,
				maxHeight / sourceHeight,
			);
			const targetWidth = Math.max(2, Math.floor(sourceWidth * scale));
			const targetHeight = Math.max(2, Math.floor(sourceHeight * scale));

			const canvas = document.createElement("canvas");
			canvas.width = targetWidth;
			canvas.height = targetHeight;
			const ctx = canvas.getContext("2d");
			if (!ctx) {
				throw new Error("Failed to initialize canvas");
			}

			const captureDuration = Math.max(
				0,
				Math.min(
					videoElement.duration || totalDurationSeconds,
					gifMaxDurationSeconds,
				),
			);
			const fps = clampInt(gifFps, 5, 30);
			const frameDelay = 1000 / fps;
			const frameCount = Math.max(1, Math.floor(captureDuration * fps));

			const gifEncoder = new GIF({
				workers: 2,
				quality: clampInt(gifQuality, 1, 20),
				width: targetWidth,
				height: targetHeight,
				workerScript: "/gif.worker.js",
				dither: gifDithering,
			});

			const cancelled = { current: false };
			const cancelHandler = () => {
				cancelled.current = true;
			};

			abortRef.current?.signal.addEventListener("abort", cancelHandler, {
				once: true,
			});

			gifEncoder.on("progress", (progress: number) => {
				setExportProgress({
					stage: "gif",
					progress: Math.min(95, Math.max(1, Math.round(progress * 100))),
					message: "Encoding GIF...",
				});
			});

			await videoElement.play();
			videoElement.pause();

			setExportProgress({
				stage: "gif",
				progress: 1,
				message: "Capturing frames...",
			});

			const captureFrame = async (time: number): Promise<void> => {
				if (cancelled.current) {
					throw new Error("Export cancelled");
				}

				await new Promise<void>((resolve) => {
					if (Math.abs(videoElement.currentTime - time) < 0.001) {
						resolve();
						return;
					}
					videoElement.currentTime = time;
					videoElement.onseeked = () => resolve();
				});

				ctx.drawImage(videoElement, 0, 0, targetWidth, targetHeight);
				gifEncoder.addFrame(canvas, { delay: frameDelay, copy: true });
			};

			const frameInterval = captureDuration / frameCount;
			for (let i = 0; i < frameCount; i++) {
				const frameTime = i * frameInterval;
				await captureFrame(frameTime);
				setExportProgress({
					stage: "gif",
					progress: Math.min(90, Math.round(((i + 1) / frameCount) * 90)),
					message: "Capturing frames...",
				});
			}

			setExportProgress({
				stage: "gif",
				progress: 90,
				message: "Encoding GIF...",
			});

			const gifBlob = await new Promise<Blob>((resolve) => {
				gifEncoder.on("finished", (blob: Blob) => resolve(blob));
				gifEncoder.render();
			});

			URL.revokeObjectURL(videoElement.src);
			setExportProgress({ stage: "gif", progress: 100, message: "Ready" });
			return gifBlob;
		},
		[
			gifDithering,
			gifFps,
			gifMaxDurationSeconds,
			gifMaxWidth,
			gifQuality,
			sourceSpec.outputHeight,
			sourceSpec.outputWidth,
			totalDurationSeconds,
		],
	);

	const handleExport = useCallback(async () => {
		if (exporting) return;

		const saveTarget = await promptSaveLocation(exportFileName, format);
		if (!saveTarget) return;

		setExporting(true);
		setExportProgress({ stage: "idle", progress: 0, message: null });

		const controller = new AbortController();
		abortRef.current?.abort();
		abortRef.current = controller;

		try {
			const rendered = await renderLocally();

			if (format === "mp4") {
				try {
					const out = await convertMp4IfNeeded(rendered.blob);
					await writeSaveTarget(saveTarget, out, exportFileName);
					toast.success("Export complete");
					return;
				} catch (error) {
					const ext = getVideoExtensionFromMimeType(rendered.mimeType);
					if (ext !== "mp4") {
						const fallbackName = exportFileName.replace(/\.mp4$/u, `.${ext}`);
						await writeSaveTarget(saveTarget, rendered.blob, fallbackName);
						toast.success("Export complete");
						return;
					}
					throw error;
				}
			}

			const gifBlob = await exportGifFromMp4(rendered.blob);
			await writeSaveTarget(saveTarget, gifBlob, exportFileName);
			toast.success("Export complete");
		} catch (error) {
			if (error instanceof Error) toast.error(error.message);
			else toast.error("Export failed");
		} finally {
			controller.abort();
			setExporting(false);
			setExportProgress({ stage: "idle", progress: 0, message: null });
		}
	}, [
		exporting,
		renderLocally,
		format,
		convertMp4IfNeeded,
		exportGifFromMp4,
		exportFileName,
	]);

	const handleCancel = useCallback(() => {
		abortRef.current?.abort();
	}, []);

	return (
		<div className="flex flex-col h-screen h-dvh bg-gray-3 overflow-hidden">
			<header className="flex items-center justify-between h-12 sm:h-14 px-2 sm:px-4 border-b border-gray-4 bg-gray-2 shrink-0">
				<Button
					variant="gray"
					size="sm"
					onClick={() => router.push(`/editor/${video.id}`)}
					className="flex items-center gap-1.5"
				>
					<ArrowLeft className="size-4" />
					<span className="hidden sm:inline">Back to Editor</span>
				</Button>
				<h1 className="text-sm font-medium text-gray-12">Export</h1>
				<div className="w-[120px] sm:w-[160px]" />
			</header>

			<div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-auto lg:overflow-hidden">
				<div className="flex flex-col flex-1 min-h-0 p-4">
					<div className="flex items-center justify-between mb-2">
						<div className="flex items-center gap-2">
							<span className="text-sm font-medium text-gray-11">Preview</span>
							<span className="text-xs text-gray-10">
								{previewSpec.outputWidth}×{previewSpec.outputHeight}
							</span>
						</div>
						<div className="text-xs text-gray-10">
							{formatTime(totalDurationSeconds)}
						</div>
					</div>

					<div className="relative flex-1 min-h-0 rounded-xl overflow-hidden bg-gray-2 border border-gray-3 flex items-center justify-center">
						<div
							ref={previewContainerRef}
							className="w-full h-full flex items-center justify-center"
						>
							<canvas ref={previewCanvasRef} className="block" />
						</div>
						{!previewReady && (
							<div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-gray-10">
								<Loader2 className="size-5 animate-spin" />
								<span className="text-sm">Generating preview...</span>
							</div>
						)}
					</div>

					<video
						ref={previewVideoRef}
						src={videoUrl}
						className="hidden"
						preload="auto"
						playsInline
					>
						<track
							kind="captions"
							srcLang="en"
							label="English"
							src="data:text/vtt;charset=utf-8,WEBVTT%0A"
						/>
					</video>
					{cameraUrl && (
						<video
							ref={previewCameraRef}
							src={cameraUrl}
							className="hidden"
							preload="auto"
							playsInline
						>
							<track
								kind="captions"
								srcLang="en"
								label="English"
								src="data:text/vtt;charset=utf-8,WEBVTT%0A"
							/>
						</video>
					)}

					<div className="flex items-center justify-between mt-3 text-xs text-gray-11">
						<div className="flex items-center gap-3">
							<span>
								Source: {sourceSpec.outputWidth}×{sourceSpec.outputHeight}
							</span>
							{effectiveResize && (
								<span>
									Export: ~
									{Math.round(sourceSpec.outputWidth * effectiveResize.scale)}×
									{Math.round(sourceSpec.outputHeight * effectiveResize.scale)}
								</span>
							)}
						</div>
						<span className="text-gray-10">Rendered locally</span>
					</div>
				</div>

				<div className="w-full lg:w-[420px] shrink-0 min-h-0 border-t lg:border-t-0 lg:border-l border-gray-3 bg-gray-2 overflow-visible lg:overflow-auto">
					<div className="p-4 flex flex-col gap-4">
						<div className="flex flex-col gap-2">
							<span className="text-sm font-medium text-gray-12">Format</span>
							<SelectRoot
								value={format}
								onValueChange={(value) => setFormat(value as ExportFormat)}
								disabled={exporting}
							>
								<SelectTrigger className="w-full">
									<SelectValue placeholder="Select format" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="mp4">MP4</SelectItem>
									<SelectItem value="gif">GIF</SelectItem>
								</SelectContent>
							</SelectRoot>
						</div>

						<div className="flex flex-col gap-2">
							<span className="text-sm font-medium text-gray-12">
								Resolution
							</span>
							<SelectRoot
								value={resolutionPreset}
								onValueChange={(value) =>
									setResolutionPreset(value as ResolutionPreset)
								}
								disabled={exporting}
							>
								<SelectTrigger className="w-full">
									<SelectValue placeholder="Select resolution" />
								</SelectTrigger>
								<SelectContent>
									{RESOLUTION_PRESETS.map((p) => (
										<SelectItem key={p.value} value={p.value}>
											{p.label}
										</SelectItem>
									))}
									<SelectItem value="custom">Custom</SelectItem>
								</SelectContent>
							</SelectRoot>
						</div>

						{resolutionPreset === "custom" && (
							<div className="flex gap-3">
								<div className="flex flex-col gap-1 flex-1">
									<span className="text-xs text-gray-11">Width</span>
									<input
										type="number"
										min={2}
										max={7680}
										value={customWidth}
										onChange={(e) => setCustomWidth(Number(e.target.value))}
										disabled={exporting}
										className="h-10 px-3 rounded-xl bg-gray-1 border border-gray-3 text-gray-12 focus:outline-none focus:ring-2 focus:ring-blue-9"
									/>
								</div>
								<div className="flex flex-col gap-1 flex-1">
									<span className="text-xs text-gray-11">Height</span>
									<input
										type="number"
										min={2}
										max={7680}
										value={customHeight}
										onChange={(e) => setCustomHeight(Number(e.target.value))}
										disabled={exporting}
										className="h-10 px-3 rounded-xl bg-gray-1 border border-gray-3 text-gray-12 focus:outline-none focus:ring-2 focus:ring-blue-9"
									/>
								</div>
							</div>
						)}

						{format === "gif" && (
							<div className="flex flex-col gap-2">
								<span className="text-sm font-medium text-gray-12">
									GIF FPS
								</span>
								<SelectRoot
									value={String(gifFps)}
									onValueChange={(value) => setGifFps(Number(value))}
									disabled={exporting}
								>
									<SelectTrigger className="w-full">
										<SelectValue placeholder="Select FPS" />
									</SelectTrigger>
									<SelectContent>
										{GIF_FPS_OPTIONS.map((o) => (
											<SelectItem key={o.value} value={String(o.value)}>
												{o.label}
											</SelectItem>
										))}
									</SelectContent>
								</SelectRoot>
							</div>
						)}

						<div className="flex items-center justify-between">
							<span className="text-sm font-medium text-gray-12">
								Advanced settings
							</span>
							<Switch
								checked={advancedOpen}
								onCheckedChange={setAdvancedOpen}
								disabled={exporting}
							/>
						</div>

						{advancedOpen && (
							<div className="flex flex-col gap-4">
								{format === "mp4" && (
									<div className="flex flex-col gap-2">
										<span className="text-sm font-medium text-gray-12">
											Codec
										</span>
										<SelectRoot
											value={mp4Codec}
											onValueChange={(value) => setMp4Codec(value as Mp4Codec)}
											disabled={exporting}
										>
											<SelectTrigger className="w-full">
												<SelectValue placeholder="Select codec" />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="h264">H.264</SelectItem>
												<SelectItem value="h265">H.265</SelectItem>
											</SelectContent>
										</SelectRoot>
									</div>
								)}

								{format === "mp4" && (
									<div className="flex items-center justify-between">
										<span className="text-sm text-gray-11">Strip audio</span>
										<Switch
											checked={stripAudio}
											onCheckedChange={setStripAudio}
											disabled={exporting}
										/>
									</div>
								)}

								{format === "gif" && (
									<div className="flex flex-col gap-3">
										<div className="flex items-center justify-between">
											<span className="text-sm text-gray-11">
												Max duration (seconds)
											</span>
											<input
												type="number"
												min={1}
												max={180}
												value={gifMaxDurationSeconds}
												onChange={(e) =>
													setGifMaxDurationSeconds(Number(e.target.value))
												}
												disabled={exporting}
												className="h-9 w-24 px-3 rounded-xl bg-gray-1 border border-gray-3 text-gray-12 focus:outline-none focus:ring-2 focus:ring-blue-9"
											/>
										</div>

										<div className="flex items-center justify-between">
											<span className="text-sm text-gray-11">Quality</span>
											<span className="text-xs text-gray-10">{gifQuality}</span>
										</div>
										<input
											type="range"
											min={1}
											max={20}
											value={gifQuality}
											onChange={(e) => setGifQuality(Number(e.target.value))}
											disabled={exporting}
											className="w-full accent-blue-9"
										/>

										<div className="flex items-center justify-between">
											<span className="text-sm text-gray-11">Max width</span>
											<span className="text-xs text-gray-10">
												{gifMaxWidth}px
											</span>
										</div>
										<input
											type="range"
											min={240}
											max={1280}
											step={80}
											value={gifMaxWidth}
											onChange={(e) => setGifMaxWidth(Number(e.target.value))}
											disabled={exporting}
											className="w-full accent-blue-9"
										/>

										<div className="flex items-center justify-between">
											<span className="text-sm text-gray-11">Dithering</span>
											<Switch
												checked={gifDithering}
												onCheckedChange={setGifDithering}
												disabled={exporting}
											/>
										</div>
									</div>
								)}
							</div>
						)}

						<div className="flex flex-col gap-2 pt-2 border-t border-gray-3">
							<Button
								variant="primary"
								size="md"
								onClick={() => void handleExport()}
								disabled={exporting}
								spinner={exporting}
							>
								Export
							</Button>

							{exporting && (
								<Button variant="gray" size="md" onClick={handleCancel}>
									Cancel
								</Button>
							)}
						</div>

						{exporting && exportProgress.stage !== "idle" && (
							<div className="flex flex-col gap-2">
								<div className="flex items-center justify-between text-xs text-gray-11">
									<span>{exportProgress.message ?? "Working..."}</span>
									<span>{Math.round(exportProgress.progress)}%</span>
								</div>
								<div className="w-full h-2 bg-gray-4 rounded-full overflow-hidden">
									<div
										className="h-full bg-blue-9 rounded-full transition-all duration-300 ease-out"
										style={{
											width: `${Math.max(2, exportProgress.progress)}%`,
										}}
									/>
								</div>
							</div>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
