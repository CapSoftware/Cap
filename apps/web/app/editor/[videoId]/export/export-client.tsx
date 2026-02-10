"use client";

import {
	computeRenderSpec,
	normalizeConfigForRender,
} from "@cap/editor-render-spec";
import { EditorRenderer } from "@cap/editor-renderer";
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
import type { ProjectConfiguration } from "../../types/project-config";
import { resolveBackgroundAssetPath } from "../../utils/backgrounds";
import { normalizeProjectForSave } from "../../utils/normalize-config";
import { formatTime, getTotalDisplayDuration } from "../../utils/time";

type ExportFormat = "mp4" | "gif";
type ResolutionPreset = "original" | "720p" | "1080p" | "4k" | "custom";

interface VideoData {
	id: string;
	name: string;
	duration: number;
	width: number;
	height: number;
}

interface ExportClientProps {
	video: VideoData;
	videoUrl: string;
	cameraUrl: string | null;
	projectConfig: ProjectConfiguration;
	projectUpdatedAt: string;
}

type RenderStatus = "IDLE" | "QUEUED" | "PROCESSING" | "COMPLETE" | "ERROR";

type SavedRenderState = {
	status: RenderStatus;
	progress?: number;
	message?: string | null;
	error?: string | null;
	updatedAt?: string;
};

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

async function fetchSavedRenderStatus(
	videoId: string,
): Promise<SavedRenderState> {
	const response = await fetch(`/api/editor/${videoId}/save`, {
		method: "GET",
		cache: "no-store",
	});

	if (!response.ok) {
		throw new Error("Failed to fetch save status");
	}

	const data = (await response.json()) as {
		status?: RenderStatus;
		renderState?: {
			progress?: number;
			message?: string | null;
			error?: string | null;
			updatedAt?: string;
		} | null;
	};

	return {
		status: data.status ?? "IDLE",
		progress: data.renderState?.progress ?? 0,
		message: data.renderState?.message ?? null,
		error: data.renderState?.error ?? null,
		updatedAt: data.renderState?.updatedAt,
	};
}

function isUpToDate(
	projectUpdatedAt: string,
	saved: SavedRenderState,
): boolean {
	if (saved.status !== "COMPLETE") return false;
	if (!saved.updatedAt) return false;
	return (
		new Date(saved.updatedAt).getTime() >= new Date(projectUpdatedAt).getTime()
	);
}

export function ExportClient({
	video,
	videoUrl,
	cameraUrl,
	projectConfig,
	projectUpdatedAt,
}: ExportClientProps) {
	const router = useRouter();

	const [format, setFormat] = useState<ExportFormat>("mp4");
	const [resolutionPreset, setResolutionPreset] =
		useState<ResolutionPreset>("original");
	const [customWidth, setCustomWidth] = useState<number>(video.width);
	const [customHeight, setCustomHeight] = useState<number>(video.height);
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const [alwaysRerender, setAlwaysRerender] = useState(false);

	const [gifFps, setGifFps] = useState<number>(15);
	const [gifQuality, setGifQuality] = useState<number>(10);
	const [gifMaxWidth, setGifMaxWidth] = useState<number>(640);
	const [gifDithering, setGifDithering] = useState(false);
	const [gifMaxDurationSeconds, setGifMaxDurationSeconds] =
		useState<number>(15);

	const [status, setStatus] = useState<SavedRenderState | null>(null);
	const [exporting, setExporting] = useState(false);
	const [exportProgress, setExportProgress] = useState<{
		stage: "idle" | "render" | "download" | "convert" | "gif";
		progress: number;
		message: string | null;
	}>({ stage: "idle", progress: 0, message: null });

	const abortRef = useRef<AbortController | null>(null);

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
		if (!preset) return { width: video.width, height: video.height };
		if (preset.value === "original")
			return { width: video.width, height: video.height };
		return {
			width: preset.width ?? video.width,
			height: preset.height ?? video.height,
		};
	}, [resolutionPreset, customWidth, customHeight, video.width, video.height]);

	const sourceSpec = useMemo(
		() => computeRenderSpec(normalizedConfig, video.width, video.height),
		[normalizedConfig, video.width, video.height],
	);

	const previewSpec = useMemo(
		() =>
			computeRenderSpec(
				normalizedConfig,
				previewBaseResolution.width,
				previewBaseResolution.height,
			),
		[
			normalizedConfig,
			previewBaseResolution.width,
			previewBaseResolution.height,
		],
	);

	const totalDurationSeconds = useMemo(() => {
		const segments = projectConfig.timeline?.segments;
		if (!segments || segments.length === 0) {
			return video.duration;
		}
		return Math.min(video.duration, getTotalDisplayDuration(segments));
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
		let cancelled = false;
		void fetchSavedRenderStatus(video.id)
			.then((s) => {
				if (cancelled) return;
				setStatus(s);
			})
			.catch(() => {
				if (cancelled) return;
				setStatus(null);
			});

		return () => {
			cancelled = true;
		};
	}, [video.id]);

	useEffect(() => {
		const canvas = previewCanvasRef.current;
		if (!canvas) return;

		const renderer = new EditorRenderer({
			canvas,
			spec: previewSpec,
			resolveBackgroundPath: resolveBackgroundAssetPath,
		});

		previewRendererRef.current = renderer;

		return () => {
			renderer.destroy();
			previewRendererRef.current = null;
		};
	}, []);

	useEffect(() => {
		previewRendererRef.current?.updateSpec(previewSpec);
		const container = previewContainerRef.current;
		if (container) {
			const rect = container.getBoundingClientRect();
			if (rect.width > 0 && rect.height > 0) {
				previewRendererRef.current?.resize(rect.width, rect.height);
			}
		}
		previewRendererRef.current?.render();
	}, [previewSpec]);

	useEffect(() => {
		const videoEl = previewVideoRef.current;
		if (!videoEl) return;

		previewRendererRef.current?.setVideoSource(videoEl);

		const onLoaded = () => {
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
			if (width > 0 && height > 0) {
				previewRendererRef.current?.resize(width, height);
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
		const base = video.name.trim() === "" ? "cap-export" : video.name.trim();
		if (format === "gif") return `${base}.gif`;
		return `${base}.mp4`;
	}, [video.name, format]);

	const startRenderIfNeeded = useCallback(async () => {
		const saved = await fetchSavedRenderStatus(video.id);
		setStatus(saved);

		const needsRender =
			alwaysRerender ||
			!isUpToDate(projectUpdatedAt, saved) ||
			saved.status === "ERROR" ||
			saved.status === "IDLE";

		if (!needsRender) return;

		if (saved.status === "QUEUED" || saved.status === "PROCESSING") {
			return;
		}

		const configToSave = normalizeProjectForSave(projectConfig);

		const response = await fetch(`/api/editor/${video.id}/save`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ config: configToSave }),
		});

		if (!response.ok) {
			const data = (await response.json().catch(() => ({}))) as {
				error?: string;
			};
			throw new Error(data.error || "Failed to start save render");
		}

		const next = await fetchSavedRenderStatus(video.id);
		setStatus(next);
	}, [video.id, projectConfig, projectUpdatedAt, alwaysRerender]);

	const waitForRenderComplete = useCallback(async () => {
		const controller = new AbortController();
		abortRef.current?.abort();
		abortRef.current = controller;

		const pollIntervalMs = 3000;
		const startedAt = Date.now();

		for (;;) {
			if (controller.signal.aborted) {
				throw new Error("Export cancelled");
			}

			const saved = await fetchSavedRenderStatus(video.id);
			setStatus(saved);

			if (saved.status === "COMPLETE") return;

			if (saved.status === "ERROR") {
				throw new Error(saved.error || "Save render failed");
			}

			if (Date.now() - startedAt > 30 * 60 * 1000) {
				throw new Error("Timed out waiting for render");
			}

			setExportProgress((p) => ({
				...p,
				stage: "render",
				progress: saved.progress ?? 0,
				message: saved.message ?? "Rendering...",
			}));

			await new Promise((r) => setTimeout(r, pollIntervalMs));
		}
	}, [video.id]);

	const downloadEditedMp4 = useCallback(async (): Promise<Blob> => {
		setExportProgress({
			stage: "download",
			progress: 0,
			message: "Downloading...",
		});

		const response = await fetch(
			`/api/playlist?videoId=${video.id}&videoType=mp4&variant=auto`,
			{ cache: "no-store" },
		);

		if (!response.ok) {
			throw new Error("Failed to download video");
		}

		const reader = response.body?.getReader();
		if (!reader) {
			return await response.blob();
		}

		const contentLengthHeader = response.headers.get("Content-Length");
		const total = contentLengthHeader ? Number(contentLengthHeader) : null;

		const chunks: Uint8Array[] = [];
		let received = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) {
				chunks.push(value);
				received += value.byteLength;
				if (total && Number.isFinite(total) && total > 0) {
					setExportProgress({
						stage: "download",
						progress: Math.min(99, Math.round((received / total) * 100)),
						message: "Downloading...",
					});
				}
			}
		}

		setExportProgress({
			stage: "download",
			progress: 100,
			message: "Download complete",
		});
		return new Blob(chunks, { type: "video/mp4" });
	}, [video.id]);

	const convertMp4IfNeeded = useCallback(
		async (input: Blob): Promise<Blob> => {
			if (!effectiveResize) return input;

			const parser = await import("@remotion/media-parser");
			const webcodecs = await import("@remotion/webcodecs");

			const controller = parser.mediaParserController
				? parser.mediaParserController()
				: null;

			setExportProgress({
				stage: "convert",
				progress: 0,
				message: "Resizing...",
			});

			const file = new File([input], exportFileName, {
				type: "video/mp4",
			});

			const result = await webcodecs.convertMedia({
				src: file,
				container: "mp4",
				resize: {
					mode: "max-height-width",
					maxHeight: effectiveResize.maxHeight,
					maxWidth: effectiveResize.maxWidth,
				},
				onProgress: ({ overallProgress }) => {
					if (overallProgress !== null) {
						setExportProgress({
							stage: "convert",
							progress: Math.min(99, Math.round(overallProgress * 100)),
							message: "Resizing...",
						});
					}
				},
				controller:
					controller as unknown as import("@remotion/webcodecs").WebCodecsController,
			});

			const blob = await result.save();
			setExportProgress({ stage: "convert", progress: 100, message: "Ready" });
			return blob;
		},
		[effectiveResize, exportFileName],
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
		setExporting(true);
		setExportProgress({ stage: "idle", progress: 0, message: null });

		try {
			await startRenderIfNeeded();
			await waitForRenderComplete();

			const mp4Blob = await downloadEditedMp4();

			if (format === "mp4") {
				const out = await convertMp4IfNeeded(mp4Blob);
				downloadBlob(out, exportFileName);
				toast.success("Export complete");
				return;
			}

			const gifBlob = await exportGifFromMp4(mp4Blob);
			downloadBlob(gifBlob, exportFileName);
			toast.success("Export complete");
		} catch (error) {
			if (error instanceof Error) toast.error(error.message);
			else toast.error("Export failed");
		} finally {
			setExporting(false);
			setExportProgress({ stage: "idle", progress: 0, message: null });
		}
	}, [
		exporting,
		startRenderIfNeeded,
		waitForRenderComplete,
		downloadEditedMp4,
		format,
		convertMp4IfNeeded,
		exportGifFromMp4,
		exportFileName,
	]);

	const handleCancel = useCallback(() => {
		abortRef.current?.abort();
	}, []);

	const savedUpToDate = status ? isUpToDate(projectUpdatedAt, status) : false;

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

			<div className="flex-1 min-h-0 overflow-auto">
				<div className="flex flex-col lg:flex-row gap-4 p-4 min-h-0">
					<div className="flex flex-col flex-1 min-h-[360px] lg:min-h-0">
						<div className="flex items-center justify-between mb-2">
							<div className="flex items-center gap-2">
								<span className="text-sm font-medium text-gray-11">
									Preview
								</span>
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
								<canvas ref={previewCanvasRef} />
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
						/>
						{cameraUrl && (
							<video
								ref={previewCameraRef}
								src={cameraUrl}
								className="hidden"
								preload="auto"
								playsInline
							/>
						)}

						<div className="flex items-center justify-between mt-3 text-xs text-gray-11">
							<div className="flex items-center gap-3">
								<span>
									Source: {sourceSpec.outputWidth}×{sourceSpec.outputHeight}
								</span>
								{effectiveResize && (
									<span>
										Export: ~
										{Math.round(sourceSpec.outputWidth * effectiveResize.scale)}
										×
										{Math.round(
											sourceSpec.outputHeight * effectiveResize.scale,
										)}
									</span>
								)}
							</div>
							<div className="flex items-center gap-2">
								<span
									className={savedUpToDate ? "text-green-11" : "text-amber-11"}
								>
									{savedUpToDate ? "Up to date" : "Needs save"}
								</span>
							</div>
						</div>
					</div>

					<div className="w-full lg:w-[420px] shrink-0">
						<div className="rounded-xl border border-gray-3 bg-gray-2 p-4 flex flex-col gap-4">
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
									<div className="flex items-center justify-between">
										<span className="text-sm text-gray-11">
											Always re-render before exporting
										</span>
										<Switch
											checked={alwaysRerender}
											onCheckedChange={setAlwaysRerender}
											disabled={exporting}
										/>
									</div>

									{resolutionPreset === "custom" && (
										<div className="flex gap-3">
											<div className="flex flex-col gap-1 flex-1">
												<span className="text-xs text-gray-11">Max width</span>
												<input
													type="number"
													min={2}
													max={7680}
													value={customWidth}
													onChange={(e) =>
														setCustomWidth(Number(e.target.value))
													}
													disabled={exporting}
													className="h-10 px-3 rounded-xl bg-gray-1 border border-gray-3 text-gray-12 focus:outline-none focus:ring-2 focus:ring-blue-9"
												/>
											</div>
											<div className="flex flex-col gap-1 flex-1">
												<span className="text-xs text-gray-11">Max height</span>
												<input
													type="number"
													min={2}
													max={7680}
													value={customHeight}
													onChange={(e) =>
														setCustomHeight(Number(e.target.value))
													}
													disabled={exporting}
													className="h-10 px-3 rounded-xl bg-gray-1 border border-gray-3 text-gray-12 focus:outline-none focus:ring-2 focus:ring-blue-9"
												/>
											</div>
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
												<span className="text-xs text-gray-10">
													{gifQuality}
												</span>
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
		</div>
	);
}
