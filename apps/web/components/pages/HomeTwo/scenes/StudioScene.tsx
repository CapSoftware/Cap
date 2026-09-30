"use client";

import { useRef } from "react";
import { CapEditorWindow } from "../demo/CapEditorWindow";
import { CapRecorderWindow } from "../demo/CapRecorderWindow";
import {
	CameraWindow,
	RecordingToolbar,
	TargetOverlayPanel,
} from "../demo/CapSurfaces";
import { CapCursor } from "../demo/capIcons";
import { ContentWindow } from "../demo/MacDesktop";
import { SCENE_META } from "./catalog";
import {
	clockText,
	easeInOut,
	lerp,
	noop,
	quantize,
	restartAnimation,
	type SceneModule,
	type SceneProps,
	Stage,
	span,
	useCursor,
	useSceneClock,
	useSceneState,
	useVideo,
	type Way,
} from "./engine";

const CHAPTERS = SCENE_META.studio.chapters;

const EDITOR = { left: 30, top: 44, width: 620, height: 389 };
const EDITOR_SCALE = EDITOR.width / 1275;
const SLIDER_PX = 384 * EDITOR_SCALE;

const POS = {
	content: { left: 250, top: 26, width: 400, height: 300 },
	recorder: { left: 36, top: 50 },
	camera: { left: 420, top: 236 },
	overlay: { left: 132, top: 130 },
	toolbar: { left: 192, top: 428 },
};

const PATH: Way[] = [
	{ t: 0, x: 330, y: 300 },
	{ t: 1200, at: "row-camera" },
	{ t: 1300, at: "row-camera", click: true },
	{ t: 2900, at: "target-display" },
	{ t: 3000, at: "target-display", click: true },
	{ t: 4600, at: "overlay-start" },
	{ t: 4700, at: "overlay-start", click: true },
	{ t: 5800, x: 590, y: 170 },
	{ t: 6400, x: 590, y: 170 },
	{ t: 7200, at: "swatch-2" },
	{ t: 7300, at: "swatch-2", click: true },
	{ t: 8300, at: "editor-padding" },
	{ t: 8400, at: "editor-padding" },
	{ t: 9400, at: "editor-padding", dx: SLIDER_PX * 0.4 },
	{ t: 10100, at: "editor-radius" },
	{ t: 10200, at: "editor-radius" },
	{ t: 11000, at: "editor-radius", dx: SLIDER_PX * 0.45 },
	{ t: 12300, at: "editor-zoom-generate" },
	{ t: 13400, at: "editor-zoom-generate" },
	{ t: 13500, at: "editor-zoom-generate", click: true },
	{ t: 14300, x: 210, y: 452 },
	{ t: 20000, x: 210, y: 452 },
];

const RECORD_START = 5000;
const STUDIO_END = 6400;
const EDITOR_OPEN = 6500;
const PLAYBACK_LOOP = 9000;
const ZOOM_GENERATE = 13500;
const ZOOM_IN = { start: 13800, end: 15200 };
const ZOOM_OUT = { start: 17800, end: 19000 };
const CANVAS_CLICK = 15500;

const uiAt = (t: number) => ({
	recorder: t < 4750,
	cameraOn: t >= 1300,
	camera: t >= 1400 && t < STUDIO_END,
	display: t >= 3000,
	overlay: t >= 3200 && t < 4700,
	toolbar: t >= RECORD_START && t < STUDIO_END,
	recording: t >= RECORD_START && t < STUDIO_END,
	content: t < STUDIO_END,
	editor: t >= EDITOR_OPEN,
	bgIndex: t >= 7300 ? 2 : 0,
	padding: quantize(0.35 + 0.4 * span(t, 8400, 9400)),
	radius: quantize(0.5 + 0.45 * span(t, 10200, 11000)),
	zoomSegments: t >= ZOOM_GENERATE,
});

const zoomAt = (t: number) =>
	1 +
	0.75 * easeInOut(span(t, ZOOM_IN.start, ZOOM_IN.end)) -
	0.75 * easeInOut(span(t, ZOOM_OUT.start, ZOOM_OUT.end));

export const StudioScene = (props: SceneProps) => {
	const layerRef = useRef<HTMLDivElement | null>(null);
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const timerRef = useRef<HTMLSpanElement | null>(null);
	const cameraRef = useRef<HTMLVideoElement | null>(null);
	const editorVideoRef = useRef<HTMLVideoElement | null>(null);
	const editorCamRef = useRef<HTMLVideoElement | null>(null);
	const playheadRef = useRef<HTMLDivElement | null>(null);
	const timeRef = useRef<HTMLSpanElement | null>(null);
	const canvasRef = useRef<HTMLDivElement | null>(null);
	const canvasCursorRef = useRef<HTMLDivElement | null>(null);
	const canvasRingRef = useRef<HTMLSpanElement | null>(null);
	const canvasClickRef = useRef(-1);
	const [ui, setUi] = useSceneState(uiAt(0));
	const cursor = useCursor(layerRef);

	useVideo(props.playing && ui.camera, cameraRef);
	useVideo(props.playing && ui.editor, editorVideoRef);
	useVideo(props.playing && ui.editor, editorCamRef);

	useSceneClock({
		...props,
		chapters: CHAPTERS,
		tick: (t, seek) => {
			setUi(uiAt(t));
			if (timerRef.current) {
				timerRef.current.textContent =
					t >= RECORD_START ? clockText(t - RECORD_START) : "0:00";
			}
			if (scrollRef.current) {
				scrollRef.current.style.transform = `translateY(${
					-70 * easeInOut(span(t, 5300, 6300))
				}px)`;
			}
			if (t >= EDITOR_OPEN) {
				const f = ((t - EDITOR_OPEN) % PLAYBACK_LOOP) / PLAYBACK_LOOP;
				if (playheadRef.current) {
					playheadRef.current.style.left = `${128 + f * 0.78 * 1131}px`;
				}
				if (timeRef.current) {
					const seconds = f * 32;
					timeRef.current.textContent = `0:${String(
						Math.floor(seconds),
					).padStart(2, "0")}.${String(
						Math.floor((seconds % 1) * 100),
					).padStart(2, "0")}`;
				}
			}
			if (canvasRef.current) {
				canvasRef.current.style.transform = `scale(${zoomAt(t)})`;
			}
			if (canvasCursorRef.current) {
				const glide = easeInOut(span(t, ZOOM_IN.start, ZOOM_IN.end));
				const settle = easeInOut(span(t, 15800, 17000));
				canvasCursorRef.current.style.left = `${lerp(
					lerp(30, 61, glide),
					52,
					settle,
				)}%`;
				canvasCursorRef.current.style.top = `${lerp(
					lerp(40, 45.5, glide),
					58,
					settle,
				)}%`;
			}
			if (seek) canvasClickRef.current = t - 1;
			if (canvasClickRef.current < CANVAS_CLICK && t >= CANVAS_CLICK) {
				restartAnimation(
					canvasRingRef.current,
					"ht-scene-ripple 620ms ease-out",
				);
			}
			canvasClickRef.current = t;
			cursor.tick(PATH, t, seek);
		},
	});

	return (
		<Stage
			wallpaper="/backgrounds/monaco.webp"
			recording={ui.recording}
			layerRef={layerRef}
		>
			<div
				className="absolute transition-opacity duration-500"
				style={{
					left: POS.content.left,
					top: POS.content.top,
					opacity: ui.content ? 1 : 0,
				}}
			>
				<ContentWindow
					width={POS.content.width}
					height={POS.content.height}
					scrollRef={scrollRef}
				/>
			</div>
			<div
				className="pointer-events-none absolute inset-0 z-20 rounded-[14px] transition-opacity duration-300"
				style={{
					opacity: ui.overlay ? 1 : 0,
					boxShadow:
						"inset 0 0 0 3px rgba(5,136,240,0.9), inset 0 0 80px rgba(5,136,240,0.18)",
					background: "rgba(17,24,39,0.10)",
				}}
			/>
			<div className="absolute z-10" style={POS.recorder}>
				<CapRecorderWindow
					ui={{
						visible: ui.recorder,
						mode: "studio",
						displaySelected: ui.display,
						cameraOn: ui.cameraOn,
					}}
					onMode={noop}
					onSelectDisplay={noop}
					onToggleCamera={noop}
					onMiss={noop}
				/>
			</div>
			<div className="absolute z-10" style={POS.camera}>
				<CameraWindow visible={ui.camera} videoRef={cameraRef} />
			</div>
			<div className="absolute z-30" style={POS.overlay}>
				<TargetOverlayPanel
					visible={ui.overlay}
					mode="studio"
					cameraOn={ui.cameraOn}
					onStart={noop}
					onClose={noop}
				/>
			</div>
			<div className="absolute z-30" style={POS.toolbar}>
				<RecordingToolbar
					visible={ui.toolbar}
					paused={false}
					timerRef={timerRef}
					onStop={noop}
					onTogglePause={noop}
					onRestart={noop}
					onMiss={noop}
				/>
			</div>
			<div
				className="absolute z-20"
				style={{ left: EDITOR.left, top: EDITOR.top }}
			>
				<CapEditorWindow
					ui={{
						visible: ui.editor,
						bgIndex: ui.bgIndex,
						playing: ui.editor,
						padding: ui.padding,
						radius: ui.radius,
						zoomSegments: ui.zoomSegments,
					}}
					width={EDITOR.width}
					height={EDITOR.height}
					videoRef={editorVideoRef}
					camVideoRef={editorCamRef}
					playheadRef={playheadRef}
					timeRef={timeRef}
					canvasRef={canvasRef}
					canvasChildren={
						<div
							ref={canvasCursorRef}
							className="absolute"
							style={{
								left: "30%",
								top: "40%",
								opacity: ui.zoomSegments ? 1 : 0,
								transition: "opacity 400ms ease",
							}}
						>
							<span
								ref={canvasRingRef}
								className="absolute -left-5 -top-5 size-10 rounded-full opacity-0"
								style={{ border: "3px solid rgba(0,144,255,0.9)" }}
							/>
							<CapCursor
								className="h-9 w-auto"
								style={{
									color: "#202020",
									filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.5))",
								}}
							/>
						</div>
					}
					onSwatch={noop}
					onExport={noop}
					onTogglePlay={noop}
				/>
			</div>
			{cursor.Cursor}
		</Stage>
	);
};

export const STUDIO: SceneModule = {
	Scene: StudioScene,
	chapters: CHAPTERS,
	poster: SCENE_META.studio.poster,
};
