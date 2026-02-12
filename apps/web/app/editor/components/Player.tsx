"use client";

import {
	computeRenderSpec,
	normalizeConfigForRender,
} from "@cap/editor-render-spec";
import { EditorRenderer } from "@cap/editor-renderer";
import { Loader2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { getAudioPlaybackGain } from "../utils/audio";
import { resolveBackgroundAssetPath } from "../utils/backgrounds";
import { useEditorContext } from "./context";
import { PlayerControls } from "./PlayerControls";

export function Player() {
	const {
		videoUrl,
		videoRef,
		cameraUrl,
		cameraVideoRef,
		setEditorState,
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

	const spec = useMemo(() => {
		const normalized = normalizeConfigForRender(project);
		return computeRenderSpec(normalized.config, video.width, video.height);
	}, [project, video.width, video.height]);

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
			<div className="flex-1 flex items-center justify-center p-4 min-h-0 relative">
				<div
					ref={containerRef}
					className="w-full h-full flex items-center justify-center"
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
