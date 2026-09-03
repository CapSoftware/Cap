"use client";

import { classNames } from "@cap/utils/helpers";
import { useRef } from "react";
import { ContentWindow } from "../demo/MacDesktop";
import { useVideoAttrs, VIDEO_POSTERS } from "../demo/media";
import {
	easeInOut,
	easeOut,
	lerp,
	restartAnimation,
	SCENE_CSS,
	span,
	typed,
	useCursor,
	useSceneState,
	useVideo,
	type Way,
} from "../scenes/engine";
import {
	CameraBubble,
	CanvasStage,
	Chip,
	RECORDED,
	RecordedWindow,
	type StudioCard,
	useLoop,
} from "./shared";

const MASK_DURATION = 8200;
const MASK = { x: RECORDED.left + 72, y: RECORDED.top + 112, w: 268, h: 52 };
const MASK_DRAG = { start: 600, end: 1700 };
const MASK_BLUR = 1900;
const MASK_PIXELATE = 3600;
const MASK_HIGHLIGHT = 5400;
const MASK_CONTROL = { x: MASK.x, y: MASK.y + MASK.h + 14 };
const MASK_MODES = ["Blur", "Pixelate", "Highlight"] as const;
const SEGMENT_W = 74;

const MASK_PATH: Way[] = [
	{ t: 0, x: MASK.x - 36, y: MASK.y - 26 },
	{ t: MASK_DRAG.start, x: MASK.x, y: MASK.y },
	{ t: MASK_DRAG.end, x: MASK.x + MASK.w, y: MASK.y + MASK.h },
	{ t: MASK_BLUR, x: MASK.x + MASK.w, y: MASK.y + MASK.h },
	{ t: 3400, x: MASK_CONTROL.x + SEGMENT_W * 1.5, y: MASK_CONTROL.y + 14 },
	{
		t: MASK_PIXELATE,
		x: MASK_CONTROL.x + SEGMENT_W * 1.5,
		y: MASK_CONTROL.y + 14,
		click: true,
	},
	{ t: 5200, x: MASK_CONTROL.x + SEGMENT_W * 2.5, y: MASK_CONTROL.y + 14 },
	{
		t: MASK_HIGHLIGHT,
		x: MASK_CONTROL.x + SEGMENT_W * 2.5,
		y: MASK_CONTROL.y + 14,
		click: true,
	},
	{ t: 6600, x: MASK.x + MASK.w + 60, y: MASK.y + MASK.h + 90 },
	{ t: MASK_DURATION, x: MASK.x + MASK.w + 60, y: MASK.y + MASK.h + 90 },
];

const PIXELS = Array.from({ length: 22 * 4 }, (_, i) => {
	const seed = Math.sin(i * 12.9898 + 4.1414) * 43758.5453;
	const v = seed - Math.floor(seed);
	const l = 62 + Math.floor(v * 30);
	return `hsl(216 22% ${l}%)`;
});

const maskUiAt = (t: number) => ({
	drawing: t >= MASK_DRAG.start && t < MASK_BLUR,
	mode:
		t >= MASK_HIGHLIGHT
			? "Highlight"
			: t >= MASK_PIXELATE
				? "Pixelate"
				: t >= MASK_BLUR
					? "Blur"
					: null,
});

const BlurVisual = ({ playing }: { playing: boolean }) => {
	const rootRef = useRef<HTMLDivElement | null>(null);
	const boxRef = useRef<HTMLDivElement | null>(null);
	const [ui, setUi] = useSceneState(maskUiAt(0));
	const cursor = useCursor(rootRef);

	useLoop({
		duration: MASK_DURATION,
		playing,
		pose: 4400,
		tick: (t, seek) => {
			setUi(maskUiAt(t));
			const drag = easeOut(span(t, MASK_DRAG.start, MASK_DRAG.end));
			if (boxRef.current) {
				boxRef.current.style.width = `${lerp(0, MASK.w, drag)}px`;
				boxRef.current.style.height = `${lerp(0, MASK.h, drag)}px`;
				boxRef.current.style.opacity = t >= MASK_DRAG.start ? "1" : "0";
			}
			cursor.tick(MASK_PATH, t, seek);
		},
	});

	const applied = ui.mode !== null;
	const highlight = ui.mode === "Highlight";

	return (
		<div ref={rootRef} className="relative">
			<CanvasStage>
				<RecordedWindow />
				<CameraBubble playing={playing} />

				<div
					ref={boxRef}
					className="pointer-events-none absolute z-20 overflow-hidden rounded-[6px]"
					style={{
						left: MASK.x,
						top: MASK.y,
						width: 0,
						height: 0,
						opacity: 0,
						border: applied
							? "2px solid #0090ff"
							: "2px dashed rgba(255,255,255,0.95)",
						boxShadow: highlight
							? "0 0 0 9999px rgba(9,12,20,0.55)"
							: applied
								? "0 0 0 1px rgba(255,255,255,0.7)"
								: "0 0 0 1px rgba(0,144,255,0.9), 0 0 0 9999px rgba(9,12,20,0.18)",
						transition: "box-shadow 420ms ease, border-color 200ms ease",
					}}
				>
					<div
						className="absolute inset-0 transition-opacity duration-300"
						style={{
							opacity: ui.mode === "Blur" ? 1 : 0,
							backdropFilter: "blur(9px) saturate(1.2)",
							WebkitBackdropFilter: "blur(9px) saturate(1.2)",
							background: "rgba(236,240,246,0.35)",
						}}
					/>
					<div
						className="absolute inset-0 grid transition-opacity duration-300"
						style={{
							opacity: ui.mode === "Pixelate" ? 1 : 0,
							gridTemplateColumns: "repeat(22, 1fr)",
							gridTemplateRows: "repeat(4, 1fr)",
						}}
					>
						{PIXELS.map((color, i) => (
							<span key={`${i}-${color}`} style={{ background: color }} />
						))}
					</div>
				</div>

				{[
					{ left: MASK.x - 5, top: MASK.y - 5 },
					{ left: MASK.x + MASK.w - 5, top: MASK.y - 5 },
					{ left: MASK.x - 5, top: MASK.y + MASK.h - 5 },
					{ left: MASK.x + MASK.w - 5, top: MASK.y + MASK.h - 5 },
				].map((handle) => (
					<span
						key={`${handle.left}-${handle.top}`}
						className="pointer-events-none absolute z-30 size-[10px] rounded-full border-2 border-[#0090ff] bg-white transition-opacity duration-300"
						style={{ ...handle, opacity: applied ? 1 : 0 }}
					/>
				))}

				<div
					className="absolute z-30 flex rounded-lg p-1 transition-[opacity,transform] duration-300"
					style={{
						left: MASK_CONTROL.x,
						top: MASK_CONTROL.y,
						background: "#fcfcfc",
						border: "1px solid rgba(0,0,0,0.08)",
						boxShadow: "0 10px 24px -12px rgba(16,24,40,0.5)",
						opacity: applied ? 1 : 0,
						transform: applied ? "translateY(0)" : "translateY(6px)",
					}}
				>
					{MASK_MODES.map((mode) => (
						<span
							key={mode}
							className={classNames(
								"flex h-7 items-center justify-center rounded-md text-[12px] font-medium transition-colors duration-200",
								ui.mode === mode
									? "bg-[#111111] text-white"
									: "text-[rgba(17,17,17,0.6)]",
							)}
							style={{ width: SEGMENT_W }}
						>
							{mode}
						</span>
					))}
				</div>
				{cursor.Cursor}
			</CanvasStage>
		</div>
	);
};

const TRACK = { top: 328, height: 36, left: 96, right: 584 } as const;

const TrackStrip = ({
	label,
	children,
	playhead,
}: {
	label: string;
	children: React.ReactNode;
	playhead: React.RefObject<HTMLDivElement | null>;
}) => (
	<div
		className="absolute inset-x-4 z-30 flex items-stretch gap-2"
		style={{ top: TRACK.top, height: TRACK.height }}
	>
		<span
			className="flex w-[72px] shrink-0 items-center justify-center rounded-lg text-[11px] font-medium text-white"
			style={{ background: "#4a4f5c", border: "1px solid #30343d" }}
		>
			{label}
		</span>
		<div
			className="relative flex-1 overflow-hidden rounded-lg"
			style={{ background: "rgba(252,252,252,0.55)" }}
		>
			{children}
			<div
				ref={playhead}
				className="pointer-events-none absolute inset-y-0 left-0 w-px"
				style={{ background: "rgb(226,64,64)" }}
			>
				<span
					className="absolute -left-[4.5px] -top-[1px] size-[10px] rounded-full"
					style={{ background: "rgb(226,64,64)" }}
				/>
			</div>
		</div>
	</div>
);

const CameraPane = ({
	playing,
	style,
	className,
}: {
	playing: boolean;
	style?: React.CSSProperties;
	className?: string;
}) => {
	const ref = useRef<HTMLVideoElement | null>(null);
	const attrs = useVideoAttrs(VIDEO_POSTERS.webcam);
	useVideo(playing, ref);
	return (
		<div
			className={classNames("absolute overflow-hidden bg-[#111111]", className)}
			style={style}
		>
			<video
				ref={ref}
				className="h-full w-full object-cover"
				src="/videos/home-two/webcam.mp4"
				muted
				loop
				playsInline
				{...attrs}
			/>
		</div>
	);
};

const SCENES_DURATION = 12000;
const SCENE_MODES = [
	{ key: "default", label: "Default" },
	{ key: "cameraOnly", label: "Camera only" },
	{ key: "splitScreen", label: "Split screen" },
	{ key: "floating", label: "Floating" },
] as const;
type SceneKey = (typeof SCENE_MODES)[number]["key"];
const SCENE_SLOT = SCENES_DURATION / SCENE_MODES.length;
const SCENE_SCREEN = { w: 360, h: 250 } as const;

const SCENE_LAYOUT: Record<
	SceneKey,
	{
		screen: {
			left: number;
			top: number;
			w: number;
			h: number;
			shift: number;
			scale: number;
			radius: number;
			opacity: number;
		};
		camera: {
			left: number;
			top: number;
			w: number;
			h: number;
			radius: number;
			opacity: number;
		};
	}
> = {
	default: {
		screen: {
			left: 120,
			top: 30,
			w: 360,
			h: 250,
			shift: 0,
			scale: 1,
			radius: 10,
			opacity: 1,
		},
		camera: { left: 28, top: 222, w: 88, h: 88, radius: 44, opacity: 1 },
	},
	cameraOnly: {
		screen: {
			left: 120,
			top: 30,
			w: 360,
			h: 250,
			shift: 0,
			scale: 1,
			radius: 10,
			opacity: 0,
		},
		camera: { left: 120, top: 30, w: 360, h: 250, radius: 12, opacity: 1 },
	},
	splitScreen: {
		screen: {
			left: 24,
			top: 30,
			w: 272,
			h: 250,
			shift: -6,
			scale: 1,
			radius: 12,
			opacity: 1,
		},
		camera: { left: 304, top: 30, w: 272, h: 250, radius: 12, opacity: 1 },
	},
	floating: {
		screen: {
			left: 52,
			top: 40,
			w: 320,
			h: 222,
			shift: 0,
			scale: 320 / 360,
			radius: 14,
			opacity: 1,
		},
		camera: { left: 396, top: 84, w: 160, h: 160, radius: 18, opacity: 1 },
	},
};

const SCENE_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const sceneTransition = `left 480ms ${SCENE_EASE}, top 480ms ${SCENE_EASE}, width 480ms ${SCENE_EASE}, height 480ms ${SCENE_EASE}, border-radius 480ms ${SCENE_EASE}, opacity 320ms ease, transform 480ms ${SCENE_EASE}`;

const sceneAt = (t: number): SceneKey =>
	SCENE_MODES[Math.min(SCENE_MODES.length - 1, Math.floor(t / SCENE_SLOT))]
		?.key ?? "default";

const ScenesVisual = ({ playing }: { playing: boolean }) => {
	const playheadRef = useRef<HTMLDivElement | null>(null);
	const [scene, setScene] = useSceneState<SceneKey>("default");
	const scrollRef = useRef<HTMLDivElement | null>(null);

	useLoop({
		duration: SCENES_DURATION,
		playing,
		pose: 7000,
		tick: (t) => {
			setScene(sceneAt(t));
			if (playheadRef.current) {
				playheadRef.current.style.left = `${(t / SCENES_DURATION) * 100}%`;
			}
		},
	});

	const layout = SCENE_LAYOUT[scene];

	return (
		<CanvasStage wallpaper="/backgrounds/sf.webp">
			<div
				className="absolute overflow-hidden"
				style={{
					left: layout.screen.left,
					top: layout.screen.top,
					width: layout.screen.w,
					height: layout.screen.h,
					borderRadius: layout.screen.radius,
					opacity: layout.screen.opacity,
					transform: layout.screen.opacity ? "scale(1)" : "scale(0.94)",
					boxShadow: "0 22px 60px rgba(0,0,0,0.28)",
					transition: sceneTransition,
				}}
			>
				<div
					className="absolute left-0 top-0"
					style={{
						width: SCENE_SCREEN.w,
						height: SCENE_SCREEN.h,
						transform: `translateX(${layout.screen.shift}px) scale(${layout.screen.scale})`,
						transformOrigin: "top left",
						transition: `transform 480ms ${SCENE_EASE}`,
					}}
				>
					<ContentWindow
						width={SCENE_SCREEN.w}
						height={SCENE_SCREEN.h}
						scrollRef={scrollRef}
					/>
				</div>
			</div>
			<CameraPane
				playing={playing}
				style={{
					left: layout.camera.left,
					top: layout.camera.top,
					width: layout.camera.w,
					height: layout.camera.h,
					borderRadius: layout.camera.radius,
					opacity: layout.camera.opacity,
					boxShadow: "0 14px 34px rgba(0,0,0,0.32)",
					transition: sceneTransition,
				}}
			/>
			<TrackStrip label="Scene" playhead={playheadRef}>
				{SCENE_MODES.map((mode, i) => (
					<span
						key={mode.key}
						className="absolute inset-y-1 flex items-center justify-center rounded-md text-[11px] font-medium text-white transition-[background-color,opacity] duration-300"
						style={{
							left: `calc(${(i / SCENE_MODES.length) * 100}% + 3px)`,
							width: `calc(${100 / SCENE_MODES.length}% - 6px)`,
							background: scene === mode.key ? "#7B5FD0" : "#B9A5F2",
							border: "1px solid rgba(123,95,208,0.5)",
						}}
					>
						{mode.label}
					</span>
				))}
			</TrackStrip>
		</CanvasStage>
	);
};

const TEXT_DURATION = 10000;
const LOWER = { enter: 400, exit: 2900 };
const STAT = { enter: 3700, exit: 6100 };
const TYPE = { enter: 6600, exit: 9400 };
const TYPEWRITER_TEXT = "Try the new flow →";

const textPresetAt = (t: number) =>
	t >= TYPE.enter - 100 && t < TYPE.exit + 300
		? "Typewriter · Typewriter"
		: t >= STAT.enter - 100 && t < STAT.exit + 300
			? "Big Stat · Pop"
			: t >= LOWER.enter - 100 && t < LOWER.exit + 300
				? "Lower Third · Slide up"
				: null;

const TextVisual = ({ playing }: { playing: boolean }) => {
	const lowerRef = useRef<HTMLDivElement | null>(null);
	const statRef = useRef<HTMLDivElement | null>(null);
	const typeRef = useRef<HTMLDivElement | null>(null);
	const typeTextRef = useRef<HTMLSpanElement | null>(null);
	const [preset, setPreset] = useSceneState<string | null>(null);
	const lastPreset = useRef("Lower Third · Slide up");
	if (preset) lastPreset.current = preset;

	useLoop({
		duration: TEXT_DURATION,
		playing,
		pose: 4800,
		tick: (t) => {
			setPreset(textPresetAt(t));
			if (lowerRef.current) {
				const inF = easeOut(span(t, LOWER.enter, LOWER.enter + 480));
				const outF = easeOut(span(t, LOWER.exit, LOWER.exit + 360));
				lowerRef.current.style.opacity = `${inF * (1 - outF)}`;
				lowerRef.current.style.transform = `translateY(${lerp(26, 0, inF) + outF * 18}px)`;
			}
			if (statRef.current) {
				const inF = span(t, STAT.enter, STAT.enter + 520);
				const overshoot = 1 + Math.sin(inF * Math.PI) * 0.12;
				const outF = easeOut(span(t, STAT.exit, STAT.exit + 320));
				statRef.current.style.opacity = `${easeOut(inF) * (1 - outF)}`;
				statRef.current.style.transform = `translateX(-50%) scale(${lerp(0.6, 1, easeOut(inF)) * overshoot})`;
			}
			if (typeRef.current && typeTextRef.current) {
				const outF = easeOut(span(t, TYPE.exit, TYPE.exit + 300));
				typeRef.current.style.opacity = `${t >= TYPE.enter ? 1 - outF : 0}`;
				typeTextRef.current.textContent =
					t >= TYPE.enter
						? typed(TYPEWRITER_TEXT, t, TYPE.enter + 200, 22)
						: "";
			}
		},
	});

	return (
		<CanvasStage wallpaper="/backgrounds/nyc.webp">
			<RecordedWindow />
			<CameraBubble playing={playing} />

			<div
				ref={lowerRef}
				className="absolute z-20 flex items-stretch gap-3 opacity-0"
				style={{ left: 136, top: 318 }}
			>
				<span className="w-[3px] rounded-full bg-[#8FC1F7]" />
				<span className="leading-tight [text-shadow:0_2px_12px_rgba(0,0,0,0.45)]">
					<span className="block text-[18px] font-semibold text-white">
						Sofia Chen
					</span>
					<span className="block text-[12.5px] font-medium text-white/80">
						Head of Product
					</span>
				</span>
			</div>

			<div
				ref={statRef}
				className="absolute left-1/2 z-20 flex -translate-x-1/2 flex-col items-center rounded-2xl px-8 py-4 opacity-0"
				style={{
					top: 104,
					background: "rgba(17,17,17,0.72)",
					boxShadow: "0 18px 40px -16px rgba(0,0,0,0.6)",
				}}
			>
				<span className="text-[64px] font-semibold leading-none tracking-[-0.04em] text-white [text-shadow:0_6px_30px_rgba(0,0,0,0.45)]">
					3.2×
				</span>
				<span className="mt-2 text-[13px] font-medium uppercase tracking-[0.08em] text-white/85 [text-shadow:0_2px_10px_rgba(0,0,0,0.45)]">
					faster onboarding
				</span>
			</div>

			<div
				ref={typeRef}
				className="absolute z-20 rounded-lg px-3 py-2 text-[14px] font-medium text-white opacity-0"
				style={{ right: 32, top: 40, background: "rgba(17,17,17,0.8)" }}
			>
				<span ref={typeTextRef} />
				<span className="ml-0.5 inline-block h-[14px] w-[1.5px] translate-y-[2px] animate-pulse bg-white/85" />
			</div>

			<div
				className="absolute left-4 top-4 z-30 transition-opacity duration-300"
				style={{ opacity: preset ? 1 : 0 }}
			>
				<Chip>{preset ?? lastPreset.current}</Chip>
			</div>
		</CanvasStage>
	);
};

const ZOOM_DURATION = 8000;
const ZOOM_FOCUS = { x: 420, y: 104 };
const ZOOM_CLICK = 1500;
const ZOOM_IN = { start: 1600, end: 2600 };
const ZOOM_OUT = { start: 5200, end: 6200 };
const ZOOM_PATH: Way[] = [
	{ t: 0, x: 300, y: 230 },
	{ t: 1400, x: ZOOM_FOCUS.x, y: ZOOM_FOCUS.y },
	{ t: ZOOM_CLICK, x: ZOOM_FOCUS.x, y: ZOOM_FOCUS.y, click: true },
	{ t: 3200, x: ZOOM_FOCUS.x, y: ZOOM_FOCUS.y },
	{ t: 4600, x: ZOOM_FOCUS.x + 26, y: ZOOM_FOCUS.y + 34 },
	{ t: ZOOM_DURATION, x: ZOOM_FOCUS.x + 26, y: ZOOM_FOCUS.y + 34 },
];

const zoomScaleAt = (t: number) =>
	1 +
	easeInOut(span(t, ZOOM_IN.start, ZOOM_IN.end)) -
	easeInOut(span(t, ZOOM_OUT.start, ZOOM_OUT.end));

const ZoomVisual = ({ playing }: { playing: boolean }) => {
	const rootRef = useRef<HTMLDivElement | null>(null);
	const zoomRef = useRef<HTMLDivElement | null>(null);
	const ringRef = useRef<HTMLSpanElement | null>(null);
	const playheadRef = useRef<HTMLDivElement | null>(null);
	const clickRef = useRef(-1);
	const [ui, setUi] = useSceneState({ segment: false });
	const cursor = useCursor(rootRef);

	useLoop({
		duration: ZOOM_DURATION,
		playing,
		pose: 3600,
		tick: (t, seek) => {
			setUi({ segment: t >= ZOOM_CLICK });
			if (zoomRef.current) {
				zoomRef.current.style.transform = `scale(${zoomScaleAt(t)})`;
			}
			if (playheadRef.current) {
				playheadRef.current.style.left = `${(t / ZOOM_DURATION) * 100}%`;
			}
			if (seek) clickRef.current = t - 1;
			if (clickRef.current < ZOOM_CLICK && t >= ZOOM_CLICK) {
				restartAnimation(ringRef.current, "ht-scene-ripple 700ms ease-out");
			}
			clickRef.current = t;
			cursor.tick(ZOOM_PATH, t, seek);
		},
	});

	return (
		<div ref={rootRef} className="relative">
			<CanvasStage wallpaper="/backgrounds/london.webp">
				<style>{SCENE_CSS}</style>
				<div
					ref={zoomRef}
					className="absolute inset-0 will-change-transform"
					style={{ transformOrigin: `${ZOOM_FOCUS.x}px ${ZOOM_FOCUS.y}px` }}
				>
					<RecordedWindow top={30} />
					<CameraBubble playing={playing} size={88} left={28} top={222} />
					<span
						ref={ringRef}
						className="pointer-events-none absolute size-9 -translate-x-1/2 -translate-y-1/2 rounded-full opacity-0"
						style={{
							left: ZOOM_FOCUS.x,
							top: ZOOM_FOCUS.y,
							border: "2px solid rgba(0,144,255,0.9)",
						}}
					/>
					<span
						className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#0090ff] transition-opacity duration-300"
						style={{
							left: ZOOM_FOCUS.x,
							top: ZOOM_FOCUS.y,
							opacity: ui.segment ? 1 : 0,
							boxShadow: "0 0 0 3px rgba(0,144,255,0.25)",
						}}
					/>
				</div>
				<TrackStrip label="Zoom" playhead={playheadRef}>
					<span
						className="absolute inset-y-1 flex items-center justify-center rounded-md text-[11px] font-medium text-white transition-opacity duration-300"
						style={{
							left: `${(ZOOM_CLICK / ZOOM_DURATION) * 100}%`,
							width: `${((ZOOM_OUT.end - ZOOM_CLICK) / ZOOM_DURATION) * 100}%`,
							background: "#4a4f5c",
							border: "1px solid #30343d",
							opacity: ui.segment ? 1 : 0,
						}}
					>
						2×
					</span>
				</TrackStrip>
				{cursor.Cursor}
			</CanvasStage>
		</div>
	);
};

const CAPTIONS_DURATION = 9000;
const CAPTION_LINES = [
	{
		start: 600,
		words: "So this is the new dashboard we’re shipping".split(" "),
	},
	{ start: 4400, words: "Every card here pulls live data".split(" ") },
];
const WORD_MS = 380;
const CAPTION_CLOCK_BASE = 4;
const BURN_TOGGLE = { x: 548, y: 30 };
const BURN_AT = 7600;
const CAPTION_PATH: Way[] = [
	{ t: 0, x: 470, y: 250 },
	{ t: 6600, x: 470, y: 250 },
	{ t: 7400, x: BURN_TOGGLE.x, y: BURN_TOGGLE.y },
	{ t: BURN_AT, x: BURN_TOGGLE.x, y: BURN_TOGGLE.y, click: true },
	{ t: 8400, x: BURN_TOGGLE.x - 60, y: BURN_TOGGLE.y + 70 },
	{ t: CAPTIONS_DURATION, x: BURN_TOGGLE.x - 60, y: BURN_TOGGLE.y + 70 },
];

const captionAt = (t: number) => {
	let line = 0;
	for (let i = 0; i < CAPTION_LINES.length; i++) {
		if (t >= (CAPTION_LINES[i]?.start ?? 0)) line = i;
	}
	const current = CAPTION_LINES[line];
	const elapsed = t - (current?.start ?? 0);
	const active = Math.min(
		(current?.words.length ?? 1) - 1,
		Math.floor(Math.max(0, elapsed) / WORD_MS),
	);
	return {
		line,
		active,
		shown: t >= (CAPTION_LINES[0]?.start ?? 0),
		burn: t >= BURN_AT,
	};
};

const CaptionsVisual = ({ playing }: { playing: boolean }) => {
	const rootRef = useRef<HTMLDivElement | null>(null);
	const clockRef = useRef<HTMLSpanElement | null>(null);
	const [ui, setUi] = useSceneState(captionAt(0));
	const cursor = useCursor(rootRef);

	useLoop({
		duration: CAPTIONS_DURATION,
		playing,
		pose: 2200,
		tick: (t, seek) => {
			setUi(captionAt(t));
			if (clockRef.current) {
				const seconds =
					CAPTION_CLOCK_BASE + Math.floor(Math.max(0, t - 600) / 1000);
				clockRef.current.textContent = `0:${String(seconds).padStart(2, "0")}`;
			}
			cursor.tick(CAPTION_PATH, t, seek);
		},
	});

	const line = CAPTION_LINES[ui.line] ?? CAPTION_LINES[0];

	return (
		<div ref={rootRef} className="relative">
			<CanvasStage wallpaper="/backgrounds/rome.webp">
				<RecordedWindow top={22} />
				<CameraBubble playing={playing} size={88} left={28} top={222} />

				<div className="absolute left-4 top-4 z-30">
					<Chip>
						<span className="size-2 rounded-full bg-[#0f7a58]" />
						English · Whisper
					</Chip>
				</div>

				<div
					className="absolute z-30 flex h-8 items-center gap-2 rounded-lg pl-2.5 pr-1.5 text-[12px] font-medium"
					style={{
						right: 16,
						top: 16,
						background: "#fcfcfc",
						color: "#202020",
						border: "1px solid rgba(0,0,0,0.08)",
						boxShadow: "0 8px 20px -10px rgba(16,24,40,0.45)",
					}}
				>
					Burn in
					<span
						className="relative inline-flex h-5 w-[34px] rounded-full transition-colors duration-200"
						style={{ background: ui.burn ? "#0090ff" : "#e0e0e0" }}
					>
						<span
							className="absolute top-[2px] size-4 rounded-full bg-white shadow-sm transition-[left] duration-200"
							style={{ left: ui.burn ? 16 : 2 }}
						/>
					</span>
				</div>

				<div
					className="absolute bottom-[22px] left-1/2 z-20 flex max-w-[540px] -translate-x-1/2 items-center justify-center gap-x-1 whitespace-nowrap rounded-xl px-4 py-2 transition-opacity duration-300"
					style={{
						background: "rgba(17,17,17,0.74)",
						opacity: ui.shown ? 1 : 0,
					}}
				>
					{line?.words.map((word, i) => (
						<span
							key={`${ui.line}-${word}-${i}`}
							className={classNames(
								"rounded-md px-1.5 py-1 text-[16px] font-medium leading-none transition-colors duration-150",
								i === ui.active ? "bg-[#0090ff] text-white" : "text-white/92",
							)}
						>
							{word}
						</span>
					))}
				</div>
				<span
					ref={clockRef}
					className="absolute z-20 rounded-md px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white/85 transition-opacity duration-300"
					style={{
						right: 16,
						bottom: 26,
						background: "rgba(17,17,17,0.6)",
						opacity: ui.shown ? 1 : 0,
					}}
				>
					0:04
				</span>
				{cursor.Cursor}
			</CanvasStage>
		</div>
	);
};

export const CARDS_A: StudioCard[] = [
	{
		key: "mask",
		title: "Blur what is private",
		body: "Drop a mask over a password, an email, or a face and choose blur or pixelate. Or flip it to a highlight that dims everything else.",
		span: 2,
		Visual: BlurVisual,
	},
	{
		key: "scenes",
		title: "Scenes for screen and camera",
		body: "Switch any stretch of the timeline to camera only, hide camera, split screen, or floating cards, each with its own transition.",
		span: 2,
		Visual: ScenesVisual,
	},
	{
		key: "text",
		title: "Text that animates",
		body: "Titles, lower thirds, big stats, and typewriter callouts as stackable tracks, with fade, slide, pop, or typewriter in and out.",
		Visual: TextVisual,
	},
	{
		key: "zoom",
		title: "Automatic zoom",
		body: "Generate zooms from your recorded clicks, or draw your own from 1x to 4.5x with a fixed focal point.",
		Visual: ZoomVisual,
	},
	{
		key: "captions",
		title: "Captions, generated locally",
		body: "Transcribe on your machine in 19 languages, fix the words, style them, and burn them in with the active word highlighted.",
		Visual: CaptionsVisual,
	},
];
