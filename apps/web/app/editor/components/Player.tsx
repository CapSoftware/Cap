"use client";

import {
	computeRenderSpec,
	normalizeConfigForRender,
} from "@cap/editor-render-spec";
import { EditorRenderer } from "@cap/editor-renderer";
import { Button, Dialog, DialogContent, DialogTitle } from "@cap/ui";
import { Check, Crop as CropIcon, Loader2, RotateCcw, X } from "lucide-react";
import {
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { getAudioPlaybackGain } from "../utils/audio";
import { resolveBackgroundAssetPath } from "../utils/backgrounds";
import { useEditorContext } from "./context";
import { PlayerControls } from "./PlayerControls";

type CropRect = {
	x: number;
	y: number;
	width: number;
	height: number;
};

type CropDragMode = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

type CropDragState = {
	mode: CropDragMode;
	startClientX: number;
	startClientY: number;
	startCrop: CropRect;
};

const MIN_CROP_SIZE = 16;

function clamp(value: number, min: number, max: number): number {
	if (value < min) return min;
	if (value > max) return max;
	return value;
}

function getFullCrop(sourceWidth: number, sourceHeight: number): CropRect {
	return { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
}

function normalizeCrop(
	crop: CropRect,
	sourceWidth: number,
	sourceHeight: number,
): CropRect {
	const minWidth = Math.max(2, Math.min(MIN_CROP_SIZE, sourceWidth));
	const minHeight = Math.max(2, Math.min(MIN_CROP_SIZE, sourceHeight));
	const maxX = Math.max(0, sourceWidth - minWidth);
	const maxY = Math.max(0, sourceHeight - minHeight);
	const x = clamp(Math.round(crop.x), 0, maxX);
	const y = clamp(Math.round(crop.y), 0, maxY);
	const width = clamp(Math.round(crop.width), minWidth, sourceWidth - x);
	const height = clamp(Math.round(crop.height), minHeight, sourceHeight - y);
	return { x, y, width, height };
}

function isFullCrop(
	crop: CropRect,
	sourceWidth: number,
	sourceHeight: number,
): boolean {
	return (
		crop.x === 0 &&
		crop.y === 0 &&
		crop.width === sourceWidth &&
		crop.height === sourceHeight
	);
}

function applyCropDrag(
	mode: CropDragMode,
	startCrop: CropRect,
	deltaX: number,
	deltaY: number,
	sourceWidth: number,
	sourceHeight: number,
): CropRect {
	const minWidth = Math.max(2, Math.min(MIN_CROP_SIZE, sourceWidth));
	const minHeight = Math.max(2, Math.min(MIN_CROP_SIZE, sourceHeight));

	if (mode === "move") {
		return normalizeCrop(
			{
				x: startCrop.x + deltaX,
				y: startCrop.y + deltaY,
				width: startCrop.width,
				height: startCrop.height,
			},
			sourceWidth,
			sourceHeight,
		);
	}

	let nextX = startCrop.x;
	let nextY = startCrop.y;
	let nextWidth = startCrop.width;
	let nextHeight = startCrop.height;

	if (mode.includes("w")) {
		const maxX = startCrop.x + startCrop.width - minWidth;
		const x = clamp(startCrop.x + deltaX, 0, maxX);
		nextX = x;
		nextWidth = startCrop.width + (startCrop.x - x);
	}

	if (mode.includes("e")) {
		nextWidth = clamp(startCrop.width + deltaX, minWidth, sourceWidth - nextX);
	}

	if (mode.includes("n")) {
		const maxY = startCrop.y + startCrop.height - minHeight;
		const y = clamp(startCrop.y + deltaY, 0, maxY);
		nextY = y;
		nextHeight = startCrop.height + (startCrop.y - y);
	}

	if (mode.includes("s")) {
		nextHeight = clamp(
			startCrop.height + deltaY,
			minHeight,
			sourceHeight - nextY,
		);
	}

	return normalizeCrop(
		{
			x: nextX,
			y: nextY,
			width: nextWidth,
			height: nextHeight,
		},
		sourceWidth,
		sourceHeight,
	);
}

export function Player() {
	const {
		videoUrl,
		videoRef,
		cameraUrl,
		cameraVideoRef,
		setEditorState,
		setProject,
		project,
		video,
		editorState,
		saveRender,
	} = useEditorContext();

	const canvasRef = useRef<HTMLCanvasElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const rendererRef = useRef<EditorRenderer | null>(null);
	const rafIdRef = useRef<number>(0);
	const audioContextRef = useRef<AudioContext | null>(null);
	const audioSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
	const audioGainRef = useRef<GainNode | null>(null);
	const cropDragRef = useRef<CropDragState | null>(null);
	const cropViewportRef = useRef<HTMLDivElement>(null);
	const cropCanvasRef = useRef<HTMLCanvasElement>(null);
	const [cropModeOpen, setCropModeOpen] = useState(false);
	const [cropViewportSize, setCropViewportSize] = useState({
		width: 0,
		height: 0,
	});
	const [cropDraft, setCropDraft] = useState<CropRect | null>(null);

	const sourceWidth = useMemo(
		() => Math.max(2, Math.round(video.width > 0 ? video.width : 1920)),
		[video.width],
	);
	const sourceHeight = useMemo(
		() => Math.max(2, Math.round(video.height > 0 ? video.height : 1080)),
		[video.height],
	);

	const projectForPreview = useMemo(() => {
		if (!cropModeOpen) return project;
		if (project.background.crop == null) return project;
		return {
			...project,
			background: {
				...project.background,
				crop: null,
			},
		};
	}, [cropModeOpen, project]);

	const spec = useMemo(() => {
		const normalized = normalizeConfigForRender(projectForPreview);
		return computeRenderSpec(normalized.config, video.width, video.height);
	}, [projectForPreview, video.width, video.height]);

	const specRef = useRef(spec);
	specRef.current = spec;

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;

		const renderer = new EditorRenderer({
			canvas,
			spec: specRef.current,
			resolveBackgroundPath: resolveBackgroundAssetPath,
		});

		rendererRef.current = renderer;

		return () => {
			renderer.destroy();
			rendererRef.current = null;
		};
	}, []);

	useEffect(() => {
		rendererRef.current?.updateSpec(spec);
		const container = containerRef.current;
		if (container) {
			const { width, height } = container.getBoundingClientRect();
			if (width > 0 && height > 0) {
				rendererRef.current?.resize(width, height);
			}
		}
		rendererRef.current?.render();
	}, [spec]);

	useEffect(() => {
		const videoEl = videoRef.current;
		if (!videoEl) return;

		rendererRef.current?.setVideoSource(videoEl);
		rendererRef.current?.render();

		const onLoaded = () => {
			rendererRef.current?.render();
		};
		videoEl.addEventListener("loadeddata", onLoaded);
		return () => {
			videoEl.removeEventListener("loadeddata", onLoaded);
		};
	}, [videoRef]);

	useEffect(() => {
		const videoEl = videoRef.current;
		if (!videoEl) return;

		const AudioContextCtor =
			window.AudioContext ||
			(window as unknown as { webkitAudioContext?: typeof AudioContext })
				.webkitAudioContext;

		if (!AudioContextCtor) return;

		try {
			const context = audioContextRef.current ?? new AudioContextCtor();
			audioContextRef.current = context;

			if (!audioSourceRef.current || !audioGainRef.current) {
				const source = context.createMediaElementSource(videoEl);
				const gain = context.createGain();
				source.connect(gain);
				gain.connect(context.destination);
				audioSourceRef.current = source;
				audioGainRef.current = gain;
			}
		} catch {}

		return () => {
			const context = audioContextRef.current;
			audioContextRef.current = null;
			audioSourceRef.current = null;
			audioGainRef.current = null;
			context?.close().catch(() => undefined);
		};
	}, [videoRef]);

	useEffect(() => {
		if (!editorState.playing) return;
		audioContextRef.current?.resume().catch(() => undefined);
	}, [editorState.playing]);

	useEffect(() => {
		const videoEl = videoRef.current;
		if (!videoEl) return;

		const gain = getAudioPlaybackGain(project.audio);
		videoEl.muted = gain <= 0;
		videoEl.volume = Math.min(1, Math.max(0, gain));

		const context = audioContextRef.current;
		const gainNode = audioGainRef.current;
		if (context && gainNode) {
			gainNode.gain.setValueAtTime(gain, context.currentTime);
		}
	}, [project.audio, videoRef]);

	useEffect(() => {
		if (!cameraUrl) return;
		const cameraEl = cameraVideoRef.current;
		if (!cameraEl) return;

		rendererRef.current?.setCameraSource(cameraEl);
		rendererRef.current?.render();

		const onLoaded = () => {
			rendererRef.current?.render();
		};
		cameraEl.addEventListener("loadeddata", onLoaded);
		return () => {
			cameraEl.removeEventListener("loadeddata", onLoaded);
		};
	}, [cameraVideoRef, cameraUrl]);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		const observer = new ResizeObserver((entries) => {
			const entry = entries[0];
			if (!entry) return;
			const { width, height } = entry.contentRect;
			if (width > 0 && height > 0) {
				rendererRef.current?.resize(width, height);
				rendererRef.current?.render();
			}
		});

		observer.observe(container);

		return () => {
			observer.disconnect();
		};
	}, []);

	const openCropMode = useCallback(() => {
		if (cropModeOpen) return;

		const full = getFullCrop(sourceWidth, sourceHeight);
		const initialCrop = project.background.crop
			? normalizeCrop(project.background.crop, sourceWidth, sourceHeight)
			: full;

		setCropDraft(initialCrop);
		setCropModeOpen(true);
		cropDragRef.current = null;

		if (editorState.playing) {
			videoRef.current?.pause();
			cameraVideoRef.current?.pause();
			setEditorState((state) => ({ ...state, playing: false }));
		}
	}, [
		cropModeOpen,
		sourceWidth,
		sourceHeight,
		project.background.crop,
		editorState.playing,
		videoRef,
		cameraVideoRef,
		setEditorState,
	]);

	const closeCropMode = useCallback(() => {
		setCropModeOpen(false);
		setCropDraft(null);
		cropDragRef.current = null;
	}, []);

	const handleCropCancel = useCallback(() => {
		closeCropMode();
	}, [closeCropMode]);

	const handleCropDialogOpenChange = useCallback(
		(open: boolean) => {
			if (!open) {
				handleCropCancel();
			}
		},
		[handleCropCancel],
	);

	const handleCropReset = useCallback(() => {
		setCropDraft(getFullCrop(sourceWidth, sourceHeight));
	}, [sourceWidth, sourceHeight]);

	const handleCropApply = useCallback(() => {
		if (!cropDraft) {
			closeCropMode();
			return;
		}

		const normalized = normalizeCrop(cropDraft, sourceWidth, sourceHeight);
		const nextCrop = isFullCrop(normalized, sourceWidth, sourceHeight)
			? null
			: normalized;

		setProject({
			...project,
			background: {
				...project.background,
				crop: nextCrop,
			},
		});
		closeCropMode();
	}, [
		cropDraft,
		sourceWidth,
		sourceHeight,
		setProject,
		project,
		closeCropMode,
	]);

	const startCropDrag = useCallback(
		(mode: CropDragMode, event: ReactPointerEvent<HTMLElement>) => {
			if (!cropDraft) return;
			event.preventDefault();
			event.stopPropagation();
			cropDragRef.current = {
				mode,
				startClientX: event.clientX,
				startClientY: event.clientY,
				startCrop: cropDraft,
			};
		},
		[cropDraft],
	);

	useEffect(() => {
		if (!cropModeOpen) {
			setCropViewportSize({ width: 0, height: 0 });
			return;
		}

		const viewport = cropViewportRef.current;
		if (!viewport) return;

		const updateSize = () => {
			const { width, height } = viewport.getBoundingClientRect();
			setCropViewportSize({
				width: Math.max(0, width),
				height: Math.max(0, height),
			});
		};

		updateSize();

		const observer = new ResizeObserver(() => {
			updateSize();
		});
		observer.observe(viewport);

		return () => {
			observer.disconnect();
		};
	}, [cropModeOpen]);

	const cropOverlayStyle = useMemo(() => {
		if (!cropDraft) return null;
		if (cropViewportSize.width <= 0 || cropViewportSize.height <= 0) return null;
		return {
			left: (cropDraft.x / sourceWidth) * cropViewportSize.width,
			top: (cropDraft.y / sourceHeight) * cropViewportSize.height,
			width: (cropDraft.width / sourceWidth) * cropViewportSize.width,
			height: (cropDraft.height / sourceHeight) * cropViewportSize.height,
		};
	}, [cropDraft, cropViewportSize, sourceWidth, sourceHeight]);

	useEffect(() => {
		if (!cropModeOpen) {
			cropDragRef.current = null;
			return;
		}

		if (cropViewportSize.width <= 0 || cropViewportSize.height <= 0) return;

		const onPointerMove = (event: PointerEvent) => {
			const drag = cropDragRef.current;
			if (!drag) return;
			event.preventDefault();

			const deltaX =
				((event.clientX - drag.startClientX) / cropViewportSize.width) *
				sourceWidth;
			const deltaY =
				((event.clientY - drag.startClientY) / cropViewportSize.height) *
				sourceHeight;

			setCropDraft(
				applyCropDrag(
					drag.mode,
					drag.startCrop,
					deltaX,
					deltaY,
					sourceWidth,
					sourceHeight,
				),
			);
		};

		const onPointerUp = () => {
			cropDragRef.current = null;
		};

		window.addEventListener("pointermove", onPointerMove);
		window.addEventListener("pointerup", onPointerUp);
		window.addEventListener("pointercancel", onPointerUp);

		return () => {
			window.removeEventListener("pointermove", onPointerMove);
			window.removeEventListener("pointerup", onPointerUp);
			window.removeEventListener("pointercancel", onPointerUp);
		};
	}, [cropModeOpen, cropViewportSize, sourceWidth, sourceHeight]);

	const renderCropPreview = useCallback(() => {
		if (!cropModeOpen) return;

		const canvas = cropCanvasRef.current;
		const videoEl = videoRef.current;
		if (!canvas || !videoEl) return;
		if (videoEl.readyState < 2) return;

		const width = Math.round(cropViewportSize.width);
		const height = Math.round(cropViewportSize.height);
		if (width <= 0 || height <= 0) return;

		const dpr = typeof window !== "undefined" ? window.devicePixelRatio : 1;
		canvas.width = Math.max(1, Math.round(width * dpr));
		canvas.height = Math.max(1, Math.round(height * dpr));
		canvas.style.width = `${width}px`;
		canvas.style.height = `${height}px`;

		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, width, height);
		ctx.drawImage(videoEl, 0, 0, width, height);
	}, [cropModeOpen, cropViewportSize, videoRef]);

	useEffect(() => {
		if (!cropModeOpen) return;

		const videoEl = videoRef.current;
		if (!videoEl) return;

		const render = () => {
			renderCropPreview();
		};

		render();

		videoEl.addEventListener("loadeddata", render);
		videoEl.addEventListener("seeked", render);
		videoEl.addEventListener("timeupdate", render);

		return () => {
			videoEl.removeEventListener("loadeddata", render);
			videoEl.removeEventListener("seeked", render);
			videoEl.removeEventListener("timeupdate", render);
		};
	}, [cropModeOpen, renderCropPreview, videoRef]);

	useEffect(() => {
		const videoEl = videoRef.current;
		if (!videoEl) return;

		if (!editorState.playing) {
			rendererRef.current?.render();
			return;
		}

		let running = true;

		type VideoWithRVFC = HTMLVideoElement & {
			requestVideoFrameCallback: (cb: () => void) => number;
		};

		const supportsRVFC =
			typeof (videoEl as VideoWithRVFC).requestVideoFrameCallback ===
			"function";

		if (supportsRVFC) {
			const vid = videoEl as VideoWithRVFC;
			const onFrame = () => {
				if (!running) return;
				rendererRef.current?.render();
				vid.requestVideoFrameCallback(onFrame);
			};
			vid.requestVideoFrameCallback(onFrame);
		} else {
			let lastTime = -1;
			const onFrame = () => {
				if (!running) return;
				if (videoEl.readyState >= 2 && videoEl.currentTime !== lastTime) {
					lastTime = videoEl.currentTime;
					rendererRef.current?.render();
				}
				rafIdRef.current = requestAnimationFrame(onFrame);
			};
			rafIdRef.current = requestAnimationFrame(onFrame);
		}

		return () => {
			running = false;
			if (rafIdRef.current) {
				cancelAnimationFrame(rafIdRef.current);
				rafIdRef.current = 0;
			}
		};
	}, [editorState.playing, videoRef]);

	const previewTime = editorState.previewTime;
	useEffect(() => {
		if (!editorState.playing && previewTime >= 0) {
			rendererRef.current?.render();
		}
	}, [previewTime, editorState.playing]);

	const handleTimeUpdate = useCallback(() => {
		if (videoRef.current) {
			const currentTime = videoRef.current.currentTime;
			setEditorState((state) => ({
				...state,
				playbackTime: currentTime,
				previewTime: currentTime,
			}));
		}
	}, [setEditorState, videoRef]);

	const handleEnded = useCallback(() => {
		setEditorState((state) => ({ ...state, playing: false }));
	}, [setEditorState]);

	return (
		<div className="flex-1 flex flex-col bg-gray-1 min-h-0">
			<div className="h-12 sm:h-14 px-3 sm:px-4 border-b border-gray-4 bg-gray-2 flex items-center justify-between gap-3">
				<div className="flex items-center gap-2">
					<Button
						variant="gray"
						size="sm"
						onClick={openCropMode}
						disabled={saveRender.isSaving}
					>
						<CropIcon className="size-4 sm:mr-1.5" />
						<span className="hidden sm:inline">Crop</span>
					</Button>
				</div>
			</div>
			<div className="flex-1 flex items-center justify-center p-4 min-h-0 relative">
				<div
					ref={containerRef}
					className="w-full h-full flex items-center justify-center relative"
					data-testid="editor-preview-container"
				>
					<canvas ref={canvasRef} data-testid="editor-preview-canvas" />
					<video
						ref={videoRef}
						src={videoUrl}
						className="hidden"
						data-testid="editor-preview-video"
						onTimeUpdate={handleTimeUpdate}
						onEnded={handleEnded}
						onPlay={() =>
							setEditorState((state) => ({ ...state, playing: true }))
						}
						onPause={() =>
							setEditorState((state) => ({ ...state, playing: false }))
						}
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
							ref={cameraVideoRef}
							src={cameraUrl}
							className="hidden"
							data-testid="editor-camera-video"
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
				</div>
				{saveRender.isSaving && (
					<SaveProgressOverlay
						progress={saveRender.saveState.progress}
						message={saveRender.saveState.message}
						onCancel={saveRender.cancel}
					/>
				)}
			</div>
			<PlayerControls />
			<Dialog open={cropModeOpen} onOpenChange={handleCropDialogOpenChange}>
				<DialogContent className="w-[96vw] max-w-[1100px] p-0 overflow-hidden">
					<DialogTitle className="sr-only">Crop Display</DialogTitle>
					<div className="h-12 sm:h-14 px-4 border-b border-gray-4 bg-gray-2 flex items-center justify-between gap-3">
						<div className="flex items-center gap-2">
							<span className="text-sm font-medium text-gray-12">
								Crop Display
							</span>
							{cropDraft && (
								<span className="text-xs text-gray-11 tabular-nums">
									{cropDraft.width} × {cropDraft.height}
								</span>
							)}
						</div>
						<div className="flex items-center gap-2 pr-8">
							<Button variant="gray" size="sm" onClick={handleCropReset}>
								<RotateCcw className="size-4 sm:mr-1.5" />
								<span className="hidden sm:inline">Reset</span>
							</Button>
							<Button variant="gray" size="sm" onClick={handleCropCancel}>
								<X className="size-4 sm:mr-1.5" />
								<span className="hidden sm:inline">Cancel</span>
							</Button>
							<Button variant="primary" size="sm" onClick={handleCropApply}>
								<Check className="size-4 sm:mr-1.5" />
								<span className="hidden sm:inline">Apply</span>
							</Button>
						</div>
					</div>
					<div className="p-4 bg-gray-1">
						<div
							ref={cropViewportRef}
							className="relative mx-auto w-full max-h-[70vh] overflow-hidden rounded-lg border border-gray-4 bg-black"
							style={{ aspectRatio: `${sourceWidth} / ${sourceHeight}` }}
						>
							<canvas ref={cropCanvasRef} className="w-full h-full block" />
							{cropDraft && cropOverlayStyle && (
								<CropOverlay
									cropRect={cropOverlayStyle}
									onStartDrag={startCropDrag}
								/>
							)}
						</div>
					</div>
				</DialogContent>
			</Dialog>
		</div>
	);
}

function CropOverlay({
	cropRect,
	onStartDrag,
}: {
	cropRect: { left: number; top: number; width: number; height: number };
	onStartDrag: (
		mode: CropDragMode,
		event: ReactPointerEvent<HTMLElement>,
	) => void;
}) {
	const handles: Array<{
		mode: CropDragMode;
		className: string;
		cursor: string;
	}> = [
		{
			mode: "nw",
			className: "left-0 top-0 -translate-x-1/2 -translate-y-1/2",
			cursor: "nwse-resize",
		},
		{
			mode: "n",
			className: "left-1/2 top-0 -translate-x-1/2 -translate-y-1/2",
			cursor: "ns-resize",
		},
		{
			mode: "ne",
			className: "right-0 top-0 translate-x-1/2 -translate-y-1/2",
			cursor: "nesw-resize",
		},
		{
			mode: "e",
			className: "right-0 top-1/2 translate-x-1/2 -translate-y-1/2",
			cursor: "ew-resize",
		},
		{
			mode: "se",
			className: "right-0 bottom-0 translate-x-1/2 translate-y-1/2",
			cursor: "nwse-resize",
		},
		{
			mode: "s",
			className: "left-1/2 bottom-0 -translate-x-1/2 translate-y-1/2",
			cursor: "ns-resize",
		},
		{
			mode: "sw",
			className: "left-0 bottom-0 -translate-x-1/2 translate-y-1/2",
			cursor: "nesw-resize",
		},
		{
			mode: "w",
			className: "left-0 top-1/2 -translate-x-1/2 -translate-y-1/2",
			cursor: "ew-resize",
		},
	];

	return (
		<div className="absolute inset-0 z-[5] pointer-events-none">
			<div
				className="absolute border-2 border-blue-9 rounded-[2px] pointer-events-auto"
				style={{
					left: cropRect.left,
					top: cropRect.top,
					width: cropRect.width,
					height: cropRect.height,
					boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.5)",
				}}
				onPointerDown={(event) => onStartDrag("move", event)}
			>
				{handles.map((handle) => (
					<div
						key={handle.mode}
						className={`absolute size-3 rounded-full border border-blue-7 bg-white ${handle.className}`}
						style={{ cursor: handle.cursor }}
						onPointerDown={(event) => onStartDrag(handle.mode, event)}
					/>
				))}
			</div>
		</div>
	);
}

function SaveProgressOverlay({
	progress,
	message,
	onCancel,
}: {
	progress: number;
	message: string | null;
	onCancel: () => void;
}) {
	const resolvedMessage = message || "Saving your changes...";
	const messageContainsPercent = /\d{1,3}%/.test(resolvedMessage);

	return (
		<div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 backdrop-blur-sm rounded-lg">
			<div className="flex flex-col items-center gap-4 max-w-xs px-6">
				<Loader2 className="size-8 text-white animate-spin" />
				<p className="text-sm text-white/90 text-center">{resolvedMessage}</p>
				<div className="w-full flex flex-col items-center gap-1.5">
					<div className="w-full h-2 bg-white/20 rounded-full overflow-hidden">
						<div
							className="h-full bg-blue-9 rounded-full transition-all duration-500 ease-out"
							style={{ width: `${Math.max(2, progress)}%` }}
						/>
					</div>
					{!messageContainsPercent && (
						<span className="text-xs text-white/70">
							{Math.round(progress)}%
						</span>
					)}
				</div>
				<button
					type="button"
					onClick={onCancel}
					className="flex items-center gap-1.5 text-xs text-white/50 hover:text-white/80 transition-colors mt-1"
				>
					<X className="size-3" />
					Cancel
				</button>
			</div>
		</div>
	);
}
