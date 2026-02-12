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

type CropAspectPreset = {
	id: string;
	label: string;
	ratio: number | null;
};

const MIN_CROP_SIZE = 16;

const DEFAULT_CROP_ASPECT_PRESET: CropAspectPreset = {
	id: "custom",
	label: "Custom",
	ratio: null,
};

const CROP_ASPECT_PRESETS: CropAspectPreset[] = [
	DEFAULT_CROP_ASPECT_PRESET,
	{ id: "instagram-story", label: "Instagram Story (9:16)", ratio: 9 / 16 },
	{ id: "tiktok", label: "TikTok (9:16)", ratio: 9 / 16 },
	{ id: "instagram-reel", label: "Instagram Reel (9:16)", ratio: 9 / 16 },
	{ id: "instagram-feed", label: "Instagram Feed (1:1)", ratio: 1 },
	{ id: "youtube", label: "YouTube (16:9)", ratio: 16 / 9 },
	{ id: "linkedin", label: "LinkedIn (4:3)", ratio: 4 / 3 },
	{ id: "portrait", label: "Portrait (4:5)", ratio: 4 / 5 },
	{ id: "tall", label: "Tall (3:4)", ratio: 3 / 4 },
];

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

function normalizeAspectCropSize(
	width: number,
	height: number,
	aspectRatio: number,
	sourceWidth: number,
	sourceHeight: number,
): Pick<CropRect, "width" | "height"> {
	const minWidth = Math.max(2, Math.min(MIN_CROP_SIZE, sourceWidth));
	const minHeight = Math.max(2, Math.min(MIN_CROP_SIZE, sourceHeight));

	let nextWidth = Math.max(width, minWidth);
	let nextHeight = Math.max(height, minHeight);

	if (nextWidth / nextHeight > aspectRatio) {
		nextWidth = nextHeight * aspectRatio;
	} else {
		nextHeight = nextWidth / aspectRatio;
	}

	if (nextWidth < minWidth) {
		nextWidth = minWidth;
		nextHeight = nextWidth / aspectRatio;
	}

	if (nextHeight < minHeight) {
		nextHeight = minHeight;
		nextWidth = nextHeight * aspectRatio;
	}

	if (nextWidth > sourceWidth) {
		nextWidth = sourceWidth;
		nextHeight = nextWidth / aspectRatio;
	}

	if (nextHeight > sourceHeight) {
		nextHeight = sourceHeight;
		nextWidth = nextHeight * aspectRatio;
	}

	return { width: nextWidth, height: nextHeight };
}

function fitCropToAspect(
	crop: CropRect,
	aspectRatio: number,
	sourceWidth: number,
	sourceHeight: number,
): CropRect {
	const centerX = crop.x + crop.width / 2;
	const centerY = crop.y + crop.height / 2;
	const size = normalizeAspectCropSize(
		crop.width,
		crop.height,
		aspectRatio,
		sourceWidth,
		sourceHeight,
	);
	const x = clamp(centerX - size.width / 2, 0, sourceWidth - size.width);
	const y = clamp(centerY - size.height / 2, 0, sourceHeight - size.height);

	return normalizeCrop(
		{
			x,
			y,
			width: size.width,
			height: size.height,
		},
		sourceWidth,
		sourceHeight,
	);
}

function applyAspectCropDrag(
	mode: CropDragMode,
	startCrop: CropRect,
	nextCrop: CropRect,
	aspectRatio: number,
	sourceWidth: number,
	sourceHeight: number,
): CropRect {
	if (mode === "move") return nextCrop;

	const anchorX = mode.includes("w")
		? startCrop.x + startCrop.width
		: mode.includes("e")
			? startCrop.x
			: startCrop.x + startCrop.width / 2;
	const anchorY = mode.includes("n")
		? startCrop.y + startCrop.height
		: mode.includes("s")
			? startCrop.y
			: startCrop.y + startCrop.height / 2;

	let desiredWidth = nextCrop.width;
	let desiredHeight = nextCrop.height;

	if (mode === "n" || mode === "s") {
		desiredWidth = desiredHeight * aspectRatio;
	} else if (mode === "e" || mode === "w") {
		desiredHeight = desiredWidth / aspectRatio;
	} else {
		const widthFromHeight = desiredHeight * aspectRatio;
		const heightFromWidth = desiredWidth / aspectRatio;
		const widthDistance = Math.abs(widthFromHeight - desiredWidth);
		const heightDistance = Math.abs(heightFromWidth - desiredHeight);

		if (widthDistance < heightDistance) {
			desiredWidth = widthFromHeight;
		} else {
			desiredHeight = heightFromWidth;
		}
	}

	const size = normalizeAspectCropSize(
		desiredWidth,
		desiredHeight,
		aspectRatio,
		sourceWidth,
		sourceHeight,
	);

	const x = clamp(
		mode.includes("w")
			? anchorX - size.width
			: mode.includes("e")
				? anchorX
				: anchorX - size.width / 2,
		0,
		sourceWidth - size.width,
	);
	const y = clamp(
		mode.includes("n")
			? anchorY - size.height
			: mode.includes("s")
				? anchorY
				: anchorY - size.height / 2,
		0,
		sourceHeight - size.height,
	);

	return normalizeCrop(
		{
			x,
			y,
			width: size.width,
			height: size.height,
		},
		sourceWidth,
		sourceHeight,
	);
}

function applyCropDragWithAspect(
	mode: CropDragMode,
	startCrop: CropRect,
	deltaX: number,
	deltaY: number,
	sourceWidth: number,
	sourceHeight: number,
	aspectRatio: number | null,
): CropRect {
	const nextCrop = applyCropDrag(
		mode,
		startCrop,
		deltaX,
		deltaY,
		sourceWidth,
		sourceHeight,
	);

	if (!aspectRatio || mode === "move") {
		return nextCrop;
	}

	return applyAspectCropDrag(
		mode,
		startCrop,
		nextCrop,
		aspectRatio,
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
	const cropPreviewVideoRef = useRef<HTMLVideoElement>(null);
	const [cropModeOpen, setCropModeOpen] = useState(false);
	const [cropDraft, setCropDraft] = useState<CropRect | null>(null);
	const [cropAspectPresetId, setCropAspectPresetId] = useState("custom");
	const fallbackSourceWidth = useMemo(
		() => Math.max(2, Math.round(video.width > 0 ? video.width : 1920)),
		[video.width],
	);
	const fallbackSourceHeight = useMemo(
		() => Math.max(2, Math.round(video.height > 0 ? video.height : 1080)),
		[video.height],
	);
	const [sourceSize, setSourceSize] = useState(() => ({
		width: fallbackSourceWidth,
		height: fallbackSourceHeight,
	}));

	const sourceWidth = sourceSize.width;
	const sourceHeight = sourceSize.height;
	const cropAspectPreset = useMemo(
		() =>
			CROP_ASPECT_PRESETS.find((preset) => preset.id === cropAspectPresetId) ??
			DEFAULT_CROP_ASPECT_PRESET,
		[cropAspectPresetId],
	);
	const cropAspectRatio = cropAspectPreset.ratio;

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
		return computeRenderSpec(normalized.config, sourceWidth, sourceHeight);
	}, [projectForPreview, sourceWidth, sourceHeight]);

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

		const updateSourceSize = () => {
			const nextWidth = Math.max(
				2,
				Math.round(videoEl.videoWidth || fallbackSourceWidth),
			);
			const nextHeight = Math.max(
				2,
				Math.round(videoEl.videoHeight || fallbackSourceHeight),
			);
			setSourceSize((current) => {
				if (current.width === nextWidth && current.height === nextHeight) {
					return current;
				}
				return { width: nextWidth, height: nextHeight };
			});
		};

		updateSourceSize();

		rendererRef.current?.setVideoSource(videoEl);
		rendererRef.current?.render();

		const onLoaded = () => {
			updateSourceSize();
			rendererRef.current?.render();
		};
		videoEl.addEventListener("loadeddata", onLoaded);
		videoEl.addEventListener("loadedmetadata", onLoaded);
		videoEl.addEventListener("resize", updateSourceSize);
		return () => {
			videoEl.removeEventListener("loadeddata", onLoaded);
			videoEl.removeEventListener("loadedmetadata", onLoaded);
			videoEl.removeEventListener("resize", updateSourceSize);
		};
	}, [videoRef, fallbackSourceWidth, fallbackSourceHeight]);

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
		const initialCropCandidate = project.background.crop
			? normalizeCrop(project.background.crop, sourceWidth, sourceHeight)
			: full;
		const initialCrop =
			cropAspectRatio == null
				? initialCropCandidate
				: fitCropToAspect(
						initialCropCandidate,
						cropAspectRatio,
						sourceWidth,
						sourceHeight,
					);

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
		cropAspectRatio,
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
		const full = getFullCrop(sourceWidth, sourceHeight);
		setCropDraft(
			cropAspectRatio == null
				? full
				: fitCropToAspect(full, cropAspectRatio, sourceWidth, sourceHeight),
		);
	}, [sourceWidth, sourceHeight, cropAspectRatio]);

	const handleCropPresetChange = useCallback(
		(nextPresetId: string) => {
			const preset =
				CROP_ASPECT_PRESETS.find((item) => item.id === nextPresetId) ??
				DEFAULT_CROP_ASPECT_PRESET;
			const ratio = preset.ratio;
			setCropAspectPresetId(preset.id);
			if (ratio == null) return;

			setCropDraft((current) => {
				if (!current) return current;
				return fitCropToAspect(current, ratio, sourceWidth, sourceHeight);
			});
		},
		[sourceWidth, sourceHeight],
	);

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
		if (!cropModeOpen) return;
		const previewVideo = cropPreviewVideoRef.current;
		const sourceVideo = videoRef.current;
		if (!previewVideo || !sourceVideo) return;

		const syncCurrentFrame = () => {
			const nextTime = sourceVideo.currentTime;
			if (!Number.isFinite(nextTime)) return;
			try {
				previewVideo.currentTime = nextTime;
			} catch {}
		};

		const handleLoadedMetadata = () => {
			syncCurrentFrame();
			previewVideo.pause();
		};

		syncCurrentFrame();
		previewVideo.pause();
		previewVideo.addEventListener("loadedmetadata", handleLoadedMetadata);

		return () => {
			previewVideo.removeEventListener("loadedmetadata", handleLoadedMetadata);
		};
	}, [cropModeOpen, videoRef]);

	const cropOverlayStyle = useMemo(() => {
		if (!cropDraft) return null;
		return {
			leftRatio: cropDraft.x / sourceWidth,
			topRatio: cropDraft.y / sourceHeight,
			widthRatio: cropDraft.width / sourceWidth,
			heightRatio: cropDraft.height / sourceHeight,
		};
	}, [cropDraft, sourceWidth, sourceHeight]);

	useEffect(() => {
		if (!cropModeOpen) {
			cropDragRef.current = null;
			return;
		}

		const onPointerMove = (event: PointerEvent) => {
			const drag = cropDragRef.current;
			if (!drag) return;
			event.preventDefault();
			const viewport = cropViewportRef.current;
			if (!viewport) return;
			const rect = viewport.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0) return;

			const deltaX =
				((event.clientX - drag.startClientX) / rect.width) * sourceWidth;
			const deltaY =
				((event.clientY - drag.startClientY) / rect.height) * sourceHeight;

			setCropDraft(
				applyCropDragWithAspect(
					drag.mode,
					drag.startCrop,
					deltaX,
					deltaY,
					sourceWidth,
					sourceHeight,
					cropAspectRatio,
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
	}, [cropModeOpen, sourceWidth, sourceHeight, cropAspectRatio]);

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
						<div className="mb-3 flex flex-wrap items-center gap-2">
							<span className="text-xs font-medium text-gray-11">
								Snap Preset
							</span>
							<select
								value={cropAspectPresetId}
								onChange={(event) => handleCropPresetChange(event.target.value)}
								className="h-9 min-w-[220px] rounded-md border border-gray-4 bg-gray-2 px-3 text-sm text-gray-12 focus:outline-none focus:ring-1 focus:ring-blue-8"
							>
								{CROP_ASPECT_PRESETS.map((preset) => (
									<option key={preset.id} value={preset.id}>
										{preset.label}
									</option>
								))}
							</select>
						</div>
						<div
							ref={cropViewportRef}
							className="relative mx-auto w-full max-h-[70vh] overflow-hidden rounded-lg border border-gray-4 bg-black"
							style={{ aspectRatio: `${sourceWidth} / ${sourceHeight}` }}
						>
							<video
								ref={cropPreviewVideoRef}
								src={videoUrl}
								className="w-full h-full block object-fill pointer-events-none"
								preload="auto"
								playsInline
								muted
							>
								<track
									kind="captions"
									srcLang="en"
									label="English"
									src="data:text/vtt;charset=utf-8,WEBVTT%0A"
								/>
							</video>
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
	cropRect: {
		leftRatio: number;
		topRatio: number;
		widthRatio: number;
		heightRatio: number;
	};
	onStartDrag: (
		mode: CropDragMode,
		event: ReactPointerEvent<HTMLElement>,
	) => void;
}) {
	const left = `${cropRect.leftRatio * 100}%`;
	const top = `${cropRect.topRatio * 100}%`;
	const width = `${cropRect.widthRatio * 100}%`;
	const height = `${cropRect.heightRatio * 100}%`;
	const bottomTop = `${(cropRect.topRatio + cropRect.heightRatio) * 100}%`;
	const rightLeft = `${(cropRect.leftRatio + cropRect.widthRatio) * 100}%`;

	const handles: Array<{
		mode: CropDragMode;
		hitAreaClassName: string;
		knobClassName: string;
		cursor: string;
	}> = [
		{
			mode: "nw",
			hitAreaClassName: "left-0 top-0 size-10 flex items-start justify-start",
			knobClassName: "ml-1 mt-1",
			cursor: "nwse-resize",
		},
		{
			mode: "n",
			hitAreaClassName:
				"left-1/2 top-0 -translate-x-1/2 w-20 h-8 flex items-start justify-center",
			knobClassName: "mt-1",
			cursor: "ns-resize",
		},
		{
			mode: "ne",
			hitAreaClassName: "right-0 top-0 size-10 flex items-start justify-end",
			knobClassName: "mr-1 mt-1",
			cursor: "nesw-resize",
		},
		{
			mode: "e",
			hitAreaClassName:
				"right-0 top-1/2 -translate-y-1/2 w-8 h-20 flex items-center justify-end",
			knobClassName: "mr-1",
			cursor: "ew-resize",
		},
		{
			mode: "se",
			hitAreaClassName: "right-0 bottom-0 size-10 flex items-end justify-end",
			knobClassName: "mr-1 mb-1",
			cursor: "nwse-resize",
		},
		{
			mode: "s",
			hitAreaClassName:
				"left-1/2 bottom-0 -translate-x-1/2 w-20 h-8 flex items-end justify-center",
			knobClassName: "mb-1",
			cursor: "ns-resize",
		},
		{
			mode: "sw",
			hitAreaClassName: "left-0 bottom-0 size-10 flex items-end justify-start",
			knobClassName: "ml-1 mb-1",
			cursor: "nesw-resize",
		},
		{
			mode: "w",
			hitAreaClassName:
				"left-0 top-1/2 -translate-y-1/2 w-8 h-20 flex items-center justify-start",
			knobClassName: "ml-1",
			cursor: "ew-resize",
		},
	];

	return (
		<div className="absolute inset-0 z-[5] pointer-events-none">
			<div
				className="absolute left-0 right-0 top-0 bg-black/55"
				style={{ height: top }}
			/>
			<div
				className="absolute left-0 right-0 bottom-0 bg-black/55"
				style={{
					top: bottomTop,
				}}
			/>
			<div
				className="absolute left-0 bg-black/55"
				style={{
					top,
					width: left,
					height,
				}}
			/>
			<div
				className="absolute right-0 bg-black/55"
				style={{
					top,
					left: rightLeft,
					height,
				}}
			/>
			<div
				className="absolute border-2 border-blue-9 rounded-[2px] pointer-events-auto shadow-[0_0_0_1px_rgba(255,255,255,0.8)]"
				style={{
					left,
					top,
					width,
					height,
				}}
				onPointerDown={(event) => onStartDrag("move", event)}
			>
				<div className="absolute inset-0 pointer-events-none">
					<div className="absolute inset-y-0 bg-white/60 w-px left-[33.3333%]" />
					<div className="absolute inset-y-0 bg-white/60 w-px left-[66.6666%]" />
					<div className="absolute inset-x-0 bg-white/60 h-px top-[33.3333%]" />
					<div className="absolute inset-x-0 bg-white/60 h-px top-[66.6666%]" />
				</div>
				{handles.map((handle) => (
					<div
						key={handle.mode}
						className={`absolute z-10 ${handle.hitAreaClassName}`}
						style={{ cursor: handle.cursor }}
						onPointerDown={(event) => onStartDrag(handle.mode, event)}
					>
						<div
							className={`size-3.5 rounded-full border-2 border-blue-9 bg-white shadow-[0_1px_4px_rgba(0,0,0,0.6)] transition-transform hover:scale-110 ${handle.knobClassName}`}
						/>
					</div>
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
