"use client";

import { useRef } from "react";
import { LucideVideo } from "../../demo/capIcons";
import { useVideoAttrs, VIDEO_POSTERS } from "../../demo/media";
import {
	useCursor,
	useSceneState,
	useVideo,
	type Way,
} from "../../scenes/engine";
import {
	CANVAS,
	ED,
	Field,
	Ground,
	HUE,
	Lane,
	Panel,
	Playhead,
	RecordedWindow,
	Segment,
	Tile,
	TRACK_GUTTER,
	TRACK_H,
	TrackLabel,
	useLoop,
} from "../shared";

/* Scenes for screen and camera: the editor's Camera Layout tiles, clicked
 * one by one, re-arrange the screen and the camera inside the frame. The
 * camera is the subject here, so this is the one card with the webcam. */

const MODES = [
	"Default",
	"Camera Only",
	"Hide Camera",
	"Split Screen",
	"Floating",
] as const;
type Mode = (typeof MODES)[number];
const SEQUENCE: Mode[] = ["Default", "Camera Only", "Split Screen", "Floating"];
const SLOT = 3000;
const DURATION = SLOT * SEQUENCE.length;

const FRAME = { left: 16, top: 48, w: 306, h: 172 };
const SCREEN = { w: 278, h: 150 };
const PANEL = { left: 338, top: 44, w: 196, scale: 1.25 };

type Box = {
	left: number;
	top: number;
	w: number;
	h: number;
	r: number;
	opacity: number;
};

const LAYOUT: Record<Mode, { screen: Box & { scale: number }; camera: Box }> = {
	Default: {
		screen: { left: 14, top: 11, w: 278, h: 150, r: 8, opacity: 1, scale: 1 },
		camera: { left: 12, top: 80, w: 80, h: 80, r: 40, opacity: 1 },
	},
	"Camera Only": {
		screen: { left: 14, top: 11, w: 278, h: 150, r: 8, opacity: 0, scale: 1 },
		camera: { left: 0, top: 0, w: FRAME.w, h: FRAME.h, r: 8, opacity: 1 },
	},
	"Hide Camera": {
		screen: { left: 14, top: 11, w: 278, h: 150, r: 8, opacity: 1, scale: 1 },
		camera: { left: 12, top: 80, w: 80, h: 80, r: 40, opacity: 0 },
	},
	"Split Screen": {
		screen: {
			left: 8,
			top: 22,
			w: 145,
			h: 128,
			r: 8,
			opacity: 1,
			scale: 128 / SCREEN.h,
		},
		camera: { left: 153, top: 22, w: 145, h: 128, r: 8, opacity: 1 },
	},
	Floating: {
		screen: {
			left: 10,
			top: 35,
			w: 190,
			h: 102,
			r: 8,
			opacity: 1,
			scale: 190 / SCREEN.w,
		},
		camera: { left: 206, top: 40, w: 92, h: 92, r: 14, opacity: 1 },
	},
};

const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const MOVE = `left 480ms ${EASE}, top 480ms ${EASE}, width 480ms ${EASE}, height 480ms ${EASE}, border-radius 480ms ${EASE}, opacity 320ms ease, transform 480ms ${EASE}`;

const tileCenter = (mode: Mode) => {
	const i = MODES.indexOf(mode);
	const col = i % 2;
	const row = Math.floor(i / 2);
	const x = 16 + col * 86 + 39;
	const y = 43.5 + row * 38 + 15;
	return { x: PANEL.left + x * PANEL.scale, y: PANEL.top + y * PANEL.scale };
};

const PATH: Way[] = [
	{ t: 0, ...tileCenter("Default") },
	{ t: 150, ...tileCenter("Default"), click: true },
	{ t: 1200, ...tileCenter("Default") },
	{ t: SLOT - 300, ...tileCenter("Camera Only") },
	{ t: SLOT, ...tileCenter("Camera Only"), click: true },
	{ t: SLOT + 1200, ...tileCenter("Camera Only") },
	{ t: SLOT * 2 - 300, ...tileCenter("Split Screen") },
	{ t: SLOT * 2, ...tileCenter("Split Screen"), click: true },
	{ t: SLOT * 2 + 1200, ...tileCenter("Split Screen") },
	{ t: SLOT * 3 - 300, ...tileCenter("Floating") },
	{ t: SLOT * 3, ...tileCenter("Floating"), click: true },
	{ t: SLOT * 3 + 1200, ...tileCenter("Floating") },
	{ t: DURATION - 300, ...tileCenter("Default") },
	{ t: DURATION, ...tileCenter("Default") },
];

const modeAt = (t: number): Mode =>
	SEQUENCE[Math.min(SEQUENCE.length - 1, Math.floor(t / SLOT))] ?? "Default";

const S = 1.15;
const LOGICAL = { w: CANVAS.w / S, h: CANVAS.h / S };
const STRIP = { left: 12, top: 254, pad: 8 };
const STRIP_W = LOGICAL.w - STRIP.left * 2;
const LANE_W = STRIP_W - STRIP.pad * 2 - TRACK_GUTTER;

const CameraPane = ({ playing, box }: { playing: boolean; box: Box }) => {
	const ref = useRef<HTMLVideoElement | null>(null);
	const attrs = useVideoAttrs(VIDEO_POSTERS.webcam);
	useVideo(playing, ref);
	return (
		<div
			className="absolute overflow-hidden bg-[#111111]"
			style={{
				left: box.left,
				top: box.top,
				width: box.w,
				height: box.h,
				borderRadius: box.r,
				opacity: box.opacity,
				boxShadow: "0 14px 34px rgba(0,0,0,0.28)",
				transition: MOVE,
			}}
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

export const Visual = ({ playing }: { playing: boolean }) => {
	const rootRef = useRef<HTMLDivElement | null>(null);
	const playheadRef = useRef<HTMLDivElement | null>(null);
	const [mode, setMode] = useSceneState<Mode>("Default");
	const cursor = useCursor(rootRef);

	useLoop({
		duration: DURATION,
		playing,
		pose: 7000,
		tick: (t, seek) => {
			setMode(modeAt(t));
			if (playheadRef.current) {
				playheadRef.current.style.transform = `translateX(${(t / DURATION) * LANE_W}px)`;
			}
			cursor.tick(PATH, t, seek);
		},
	});

	const layout = LAYOUT[mode];

	return (
		<div ref={rootRef} className="relative">
			<Ground tone="light">
				<div
					className="absolute overflow-hidden rounded-lg"
					style={{
						left: FRAME.left,
						top: FRAME.top,
						width: FRAME.w,
						height: FRAME.h,
						background:
							"linear-gradient(135deg, #C3DCF8 0%, #DACBF9 55%, #F6D9EC 100%)",
						boxShadow:
							"0 12px 32px -8px rgba(0,0,0,0.25), 0 0 0 0.5px rgba(0,0,0,0.12)",
					}}
				>
					<div
						className="absolute overflow-hidden"
						style={{
							left: layout.screen.left,
							top: layout.screen.top,
							width: layout.screen.w,
							height: layout.screen.h,
							borderRadius: layout.screen.r,
							opacity: layout.screen.opacity,
							transform: layout.screen.opacity ? "scale(1)" : "scale(0.94)",
							boxShadow: "0 18px 40px rgba(0,0,0,0.22)",
							transition: MOVE,
						}}
					>
						<RecordedWindow
							left={0}
							top={0}
							width={SCREEN.w}
							height={SCREEN.h}
							scale={layout.screen.scale}
							style={{ transition: `transform 480ms ${EASE}` }}
						/>
					</div>
					<CameraPane playing={playing} box={layout.camera} />
				</div>

				<div
					className="absolute"
					style={{
						left: PANEL.left,
						top: PANEL.top,
						width: PANEL.w,
						transform: `scale(${PANEL.scale})`,
						transformOrigin: "top left",
					}}
				>
					<Panel className="left-0 top-0 w-full">
						<Field label="Camera Layout">
							<div className="grid grid-cols-2 gap-2">
								{MODES.map((item) => (
									<Tile
										key={item}
										selected={mode === item}
										className="overflow-hidden px-1"
									>
										{item}
									</Tile>
								))}
							</div>
						</Field>
					</Panel>
				</div>

				<div
					className="absolute left-0 top-0"
					style={{
						width: LOGICAL.w,
						height: LOGICAL.h,
						transform: `scale(${S})`,
						transformOrigin: "top left",
					}}
				>
					<div
						className="absolute flex rounded-xl"
						style={{
							left: STRIP.left,
							top: STRIP.top,
							width: STRIP_W,
							padding: STRIP.pad,
							background: ED.card,
							boxShadow: ED.cardShadow,
						}}
					>
						<TrackLabel
							hue={HUE.scene}
							icon={<LucideVideo className="size-3.5" />}
						>
							Scene
						</TrackLabel>
						<Lane>
							{SEQUENCE.map((item, i) => (
								<Segment
									key={item}
									hue={HUE.scene}
									label={item}
									selected={mode === item}
									style={{
										left: `calc(${(i / SEQUENCE.length) * 100}% + ${i ? 3 : 0}px)`,
										width: `calc(${100 / SEQUENCE.length}% - 3px)`,
									}}
								/>
							))}
							<Playhead playheadRef={playheadRef} top={-6} bottom={0} />
						</Lane>
					</div>
				</div>
				{cursor.Cursor}
			</Ground>
		</div>
	);
};

export const SCENE_TRACK_H = TRACK_H;
