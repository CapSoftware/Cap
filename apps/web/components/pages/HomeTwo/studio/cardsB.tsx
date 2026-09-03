"use client";

import { classNames } from "@cap/utils/helpers";
import Image from "next/image";
import { useRef } from "react";
import {
	easeInOut,
	lerp,
	span,
	useCursor,
	useSceneState,
	type Way,
} from "../scenes/engine";
import {
	CANVAS,
	CameraBubble,
	CanvasStage,
	Chip,
	RECORDED,
	RecordedWindow,
	useLoop,
} from "./shared";

/* ------------------------------------------------------------ 3D camera -- */

const THREE_D_DURATION = 9000;

const threeDPoseAt = (t: number) => {
	if (t < 3000) {
		const f = easeInOut(span(t, 0, 3000));
		return {
			ry: lerp(-14, 14, f),
			rx: 0,
			tx: lerp(-28, 28, f),
			s: 1,
			label: "Glide across",
		};
	}
	if (t < 6000) {
		const f = easeInOut(span(t, 3000, 6000));
		return {
			ry: lerp(14, 0, f),
			rx: lerp(0, 10, f),
			tx: lerp(28, 0, f),
			s: lerp(1, 0.86, f),
			label: "Pull back",
		};
	}
	if (t < 7500) {
		const f = easeInOut(span(t, 6000, 7500));
		return {
			ry: lerp(0, -24, f),
			rx: lerp(10, 6, f),
			tx: lerp(0, -10, f),
			s: lerp(0.86, 1, f),
			label: "Tilt away",
		};
	}
	const f = easeInOut(span(t, 7500, THREE_D_DURATION));
	return {
		ry: lerp(-24, -14, f),
		rx: lerp(6, 0, f),
		tx: lerp(-10, -28, f),
		s: 1,
		label: "Tilt away",
	};
};

export const ThreeDVisual = ({ playing }: { playing: boolean }) => {
	const groupRef = useRef<HTMLDivElement | null>(null);
	const depthRef = useRef<HTMLDivElement | null>(null);
	const vignetteRef = useRef<HTMLDivElement | null>(null);
	const floorRef = useRef<HTMLDivElement | null>(null);
	const [ui, setUi] = useSceneState({ label: "Glide across" });

	useLoop({
		duration: THREE_D_DURATION,
		playing,
		pose: 6900,
		tick: (t) => {
			const pose = threeDPoseAt(t);
			setUi({ label: pose.label });
			const tilt = Math.min(1, Math.abs(pose.ry) / 24);
			if (groupRef.current) {
				groupRef.current.style.transform = `translateX(${pose.tx}px) scale(${pose.s}) rotateY(${pose.ry}deg) rotateX(${pose.rx}deg)`;
			}
			if (depthRef.current) {
				depthRef.current.style.opacity = `${tilt * 0.55}`;
				depthRef.current.style.background =
					pose.ry > 0
						? "linear-gradient(to right, rgba(9,12,20,0) 35%, rgba(9,12,20,0.75))"
						: "linear-gradient(to left, rgba(9,12,20,0) 35%, rgba(9,12,20,0.75))";
			}
			if (vignetteRef.current) {
				vignetteRef.current.style.opacity = `${0.18 + tilt * 0.4}`;
			}
			if (floorRef.current) {
				floorRef.current.style.transform = `translateX(${pose.tx * 1.15}px) scaleX(${0.7 + pose.s * 0.4}) scaleY(${pose.s})`;
				floorRef.current.style.opacity = `${0.35 + tilt * 0.3}`;
			}
		},
	});

	return (
		<CanvasStage wallpaper="/backgrounds/rome.webp">
			<div
				ref={vignetteRef}
				className="pointer-events-none absolute inset-0 z-0"
				style={{
					background:
						"radial-gradient(80% 70% at 50% 50%, rgba(9,12,20,0) 45%, rgba(9,12,20,0.7) 100%)",
					opacity: 0.18,
				}}
			/>
			<div
				ref={floorRef}
				className="pointer-events-none absolute z-0 rounded-full"
				style={{
					left: RECORDED.left + 30,
					top: RECORDED.top + RECORDED.height + 8,
					width: RECORDED.width - 60,
					height: 26,
					background:
						"radial-gradient(50% 50% at 50% 50%, rgba(9,12,20,0.55), rgba(9,12,20,0))",
					filter: "blur(6px)",
					opacity: 0.35,
				}}
			/>
			<div
				className="absolute inset-0 z-10"
				style={{ perspective: 900, perspectiveOrigin: "50% 45%" }}
			>
				<div
					ref={groupRef}
					className="absolute inset-0 will-change-transform"
					style={{ transformStyle: "preserve-3d" }}
				>
					<RecordedWindow />
					<CameraBubble
						playing={playing}
						size={84}
						left={RECORDED.left - 36}
						top={RECORDED.top + RECORDED.height - 60}
					/>
					<div
						ref={depthRef}
						className="pointer-events-none absolute rounded-[10px]"
						style={{
							left: RECORDED.left,
							top: RECORDED.top,
							width: RECORDED.width,
							height: RECORDED.height,
							opacity: 0,
						}}
					/>
				</div>
			</div>
			<div className="absolute left-4 top-4 z-20 flex items-center gap-2">
				<Chip>
					<span
						className="size-2 rounded-full"
						style={{ background: "#7B5FD0" }}
					/>
					3D camera
				</Chip>
				<Chip style={{ color: "rgba(17,17,17,0.6)" }}>{ui.label}</Chip>
			</div>
		</CanvasStage>
	);
};

/* --------------------------------------------------------------- canvas -- */

const CANVAS_DURATION = 10000;
const WALLS = [
	"/backgrounds/monaco.webp",
	"/backgrounds/santorini.webp",
	"/backgrounds/nyc.webp",
];
type FrameKind = "none" | "browser" | "macbook";

const canvasUiAt = (t: number) => ({
	wall: t < 2500 ? 0 : t < 5000 ? 1 : 2,
	frame: (t < 5000
		? "none"
		: t < 7600
			? "browser"
			: t < 9500
				? "macbook"
				: "none") as FrameKind,
});

const FRAME_LABEL: Record<FrameKind, string> = {
	none: "Frame · None",
	browser: "Frame · Browser",
	macbook: "Frame · MacBook",
};

const canvasScaleAt = (t: number) => {
	const grow = easeInOut(span(t, 2500, 3500));
	const back = easeInOut(span(t, 9500, CANVAS_DURATION));
	const s = lerp(lerp(1, 0.9, grow), 1, back);
	const r = lerp(lerp(10, 20, grow), 10, back);
	return { s, r };
};

export const CanvasVisual = ({ playing }: { playing: boolean }) => {
	const groupRef = useRef<HTMLDivElement | null>(null);
	const clipRef = useRef<HTMLDivElement | null>(null);
	const [ui, setUi] = useSceneState(canvasUiAt(0));

	useLoop({
		duration: CANVAS_DURATION,
		playing,
		pose: 6400,
		tick: (t) => {
			setUi(canvasUiAt(t));
			const { s, r } = canvasScaleAt(t);
			if (groupRef.current) groupRef.current.style.transform = `scale(${s})`;
			if (clipRef.current) clipRef.current.style.borderRadius = `${r}px`;
		},
	});

	const browser = ui.frame === "browser";
	const macbook = ui.frame === "macbook";

	return (
		<CanvasStage wallpaper={WALLS[0]}>
			{WALLS.slice(1).map((wall, i) => (
				<Image
					key={wall}
					src={wall}
					alt=""
					fill
					sizes="600px"
					draggable={false}
					className="object-cover transition-opacity duration-700"
					style={{ opacity: ui.wall >= i + 1 ? 1 : 0 }}
				/>
			))}
			<div
				ref={groupRef}
				className="absolute will-change-transform"
				style={{
					left: RECORDED.left,
					top: RECORDED.top,
					width: RECORDED.width,
					height: RECORDED.height,
					transformOrigin: "50% 55%",
				}}
			>
				<div
					className="pointer-events-none absolute transition-[opacity,transform] duration-500"
					style={{
						left: -14,
						top: -14,
						right: -14,
						bottom: -14,
						borderRadius: 22,
						background: "linear-gradient(180deg, #2b2d33 0%, #101114 12%)",
						boxShadow:
							"inset 0 0 0 1px rgba(255,255,255,0.08), 0 30px 60px -30px rgba(9,12,20,0.7)",
						opacity: macbook ? 1 : 0,
						transform: macbook ? "scale(1)" : "scale(1.04)",
					}}
				/>
				<div
					className="pointer-events-none absolute transition-opacity duration-500"
					style={{
						left: -48,
						right: -48,
						bottom: -26,
						height: 12,
						borderRadius: "0 0 14px 14px",
						background: "linear-gradient(180deg, #d7d9de, #9a9ea6)",
						boxShadow: "0 14px 30px -12px rgba(9,12,20,0.6)",
						opacity: macbook ? 1 : 0,
					}}
				/>
				<div
					className="pointer-events-none absolute inset-x-0 flex items-center gap-2 px-3 transition-[opacity,transform] duration-500"
					style={{
						top: -34,
						height: 36,
						borderRadius: "10px 10px 0 0",
						background: "#f6f7f9",
						border: "1px solid rgba(0,0,0,0.08)",
						borderBottom: "none",
						opacity: browser ? 1 : 0,
						transform: browser ? "translateY(0)" : "translateY(10px)",
					}}
				>
					<span className="flex items-center gap-1.5">
						{["#FF5F57", "#FEBC2E", "#28C840"].map((color) => (
							<span
								key={color}
								className="size-[9px] rounded-full"
								style={{ background: color }}
							/>
						))}
					</span>
					<span
						className="ml-1 flex h-6 items-center rounded-t-md px-3 text-[10.5px] font-medium"
						style={{ background: "#ffffff", color: "#202020" }}
					>
						Dashboard
					</span>
					<span
						className="ml-auto flex h-5 w-[46%] items-center justify-center rounded-md text-[10px]"
						style={{
							background: "rgba(17,17,17,0.06)",
							color: "rgba(17,17,17,0.6)",
						}}
					>
						acme.com/dashboard
					</span>
				</div>
				<div
					ref={clipRef}
					className="absolute inset-0 overflow-hidden transition-[border-radius] duration-500"
					style={{
						borderRadius: 10,
						boxShadow: "0 24px 50px -20px rgba(9,12,20,0.6)",
					}}
				>
					<div
						className="absolute inset-x-0 transition-[top] duration-500"
						style={{ top: browser ? -40 : 0 }}
					>
						<RecordedWindow left={0} top={0} />
					</div>
				</div>
			</div>
			<CameraBubble playing={playing} />
			<div className="absolute left-4 top-4 z-20 flex gap-2">
				<Chip>{FRAME_LABEL[ui.frame]}</Chip>
			</div>
		</CanvasStage>
	);
};

/* --------------------------------------------------------------- grades -- */

type Grade = {
	name: string;
	filter: string;
	tint: string;
	sliders: [number, number, number];
};

const NONE_GRADE: Grade = {
	name: "None",
	filter: "none",
	tint: "transparent",
	sliders: [0.5, 0.5, 0.5],
};

const GRADES: Grade[] = [
	{
		name: "Cinematic",
		filter: "contrast(1.15) saturate(0.82) sepia(0.12)",
		tint: "rgba(24,52,92,0.18)",
		sliders: [0.45, 0.68, 0.42],
	},
	{
		name: "Noir",
		filter: "grayscale(1) contrast(1.25) brightness(0.96)",
		tint: "rgba(0,0,0,0.08)",
		sliders: [0.48, 0.78, 0.02],
	},
	{
		name: "Vintage",
		filter: "sepia(0.45) contrast(0.95) brightness(1.04) saturate(0.9)",
		tint: "rgba(255,196,120,0.16)",
		sliders: [0.56, 0.42, 0.44],
	},
	{
		name: "Frost",
		filter: "saturate(0.75) brightness(1.06) hue-rotate(-8deg)",
		tint: "rgba(168,208,255,0.24)",
		sliders: [0.6, 0.46, 0.36],
	},
	{
		name: "Golden",
		filter: "sepia(0.3) saturate(1.2) brightness(1.03)",
		tint: "rgba(255,186,74,0.2)",
		sliders: [0.55, 0.52, 0.66],
	},
	{
		name: "Midnight",
		filter: "brightness(0.82) contrast(1.15) saturate(0.9) hue-rotate(12deg)",
		tint: "rgba(22,30,86,0.3)",
		sliders: [0.3, 0.66, 0.45],
	},
	{
		name: "Vivid",
		filter: "saturate(1.55) contrast(1.08)",
		tint: "transparent",
		sliders: [0.52, 0.6, 0.88],
	},
	{
		name: "Dreamy",
		filter: "brightness(1.08) contrast(0.88) saturate(1.15)",
		tint: "rgba(255,190,230,0.18)",
		sliders: [0.66, 0.36, 0.62],
	},
];

const GRADES_DURATION = 9600;
const SWATCH = { w: 62, gap: 6, x: 16, y: CANVAS.h - 16 - 26 };
const GRADE_STOPS: { name: string; at: number }[] = [
	{ name: "Cinematic", at: 1000 },
	{ name: "Noir", at: 2400 },
	{ name: "Golden", at: 3800 },
	{ name: "Midnight", at: 5200 },
	{ name: "Vivid", at: 6600 },
	{ name: "Dreamy", at: 8000 },
];
const SLIDER_LABELS = ["Exposure", "Contrast", "Saturation"];

const swatchCenter = (name: string) => {
	const index = GRADES.findIndex((grade) => grade.name === name);
	return {
		x: SWATCH.x + index * (SWATCH.w + SWATCH.gap) + SWATCH.w / 2,
		y: SWATCH.y + 13,
	};
};

const GRADE_PATH: Way[] = [
	{ t: 0, x: 320, y: 190 },
	...GRADE_STOPS.flatMap((stop) => {
		const point = swatchCenter(stop.name);
		return [
			{ t: stop.at - 160, ...point },
			{ t: stop.at, ...point, click: true },
		];
	}),
	{ t: GRADES_DURATION - 600, x: 420, y: 210 },
	{ t: GRADES_DURATION, x: 420, y: 210 },
];

const gradeAt = (t: number) => {
	let current = NONE_GRADE.name;
	for (const stop of GRADE_STOPS) if (t >= stop.at) current = stop.name;
	return current;
};

export const GradesVisual = ({ playing }: { playing: boolean }) => {
	const rootRef = useRef<HTMLDivElement | null>(null);
	const [ui, setUi] = useSceneState({ grade: NONE_GRADE.name });
	const cursor = useCursor(rootRef);

	useLoop({
		duration: GRADES_DURATION,
		playing,
		pose: 4600,
		tick: (t, seek) => {
			setUi({ grade: gradeAt(t) });
			cursor.tick(GRADE_PATH, t, seek);
		},
	});

	const grade = GRADES.find((item) => item.name === ui.grade) ?? NONE_GRADE;

	return (
		<div ref={rootRef} className="relative">
			<CanvasStage wallpaper="/backgrounds/liverpool.webp">
				<div
					className="absolute inset-0 transition-[filter] duration-500"
					style={{ filter: grade.filter }}
				>
					<RecordedWindow left={56} top={RECORDED.top - 14} />
					<CameraBubble playing={playing} top={CANVAS.h - 24 - 96 - 40} />
				</div>
				<div
					className="pointer-events-none absolute inset-0 transition-[background-color] duration-500"
					style={{ background: grade.tint, mixBlendMode: "multiply" }}
				/>
				<div
					className="pointer-events-none absolute inset-0 transition-opacity duration-500"
					style={{
						background:
							"radial-gradient(85% 75% at 50% 50%, rgba(9,12,20,0) 55%, rgba(9,12,20,0.55) 100%)",
						opacity: ui.grade === "None" ? 0 : 0.6,
					}}
				/>

				<div
					className="absolute z-20 flex w-[164px] flex-col gap-2.5 rounded-[12px] p-3"
					style={{
						left: CANVAS.w - 164 - 16,
						top: 16,
						background: "#fcfcfc",
						border: "1px solid rgba(0,0,0,0.08)",
						boxShadow: "0 12px 30px -16px rgba(16,24,40,0.5)",
					}}
				>
					{SLIDER_LABELS.map((label, i) => (
						<div key={label} className="flex flex-col gap-1.5">
							<span className="text-[10.5px] font-medium text-[#202020]">
								{label}
							</span>
							<span className="relative flex h-3 items-center">
								<span
									className="h-[3px] w-full overflow-hidden rounded-full"
									style={{ background: "#e8e8e8" }}
								>
									<span
										className="block h-full rounded-full transition-[width] duration-500"
										style={{
											width: `${(grade.sliders[i] ?? 0.5) * 100}%`,
											background: "#0090ff",
										}}
									/>
								</span>
								<span
									className="absolute size-3 rounded-full border bg-white shadow-sm transition-[left] duration-500"
									style={{
										left: `calc(${(grade.sliders[i] ?? 0.5) * 100}% - 6px)`,
										borderColor: "#d9d9d9",
									}}
								/>
							</span>
						</div>
					))}
				</div>

				<div
					className="absolute z-20 flex"
					style={{ left: SWATCH.x, top: SWATCH.y, gap: SWATCH.gap }}
				>
					{GRADES.map((item) => (
						<span
							key={item.name}
							className={classNames(
								"flex h-[26px] items-center justify-center rounded-lg text-[11px] font-medium transition-colors duration-200",
								ui.grade === item.name
									? "bg-[#111111] text-white"
									: "bg-[rgba(252,252,252,0.92)] text-[#202020]",
							)}
							style={{
								width: SWATCH.w,
								boxShadow: "0 8px 20px -12px rgba(16,24,40,0.6)",
							}}
						>
							{item.name}
						</span>
					))}
				</div>
				{cursor.Cursor}
			</CanvasStage>
		</div>
	);
};

/* ---------------------------------------------------------------- clips -- */

const CLIPS_DURATION = 10000;
const PANEL = { x: 16, y: 206, w: 568, h: 153 };
const GUTTER = 68;
const LANE_X = PANEL.x + 16 + GUTTER + 8;
const LANE_W = PANEL.w - 32 - GUTTER - 8;
const TRACK_Y = PANEL.y + 16 + 22 + 8;
const TRACK_H = 40;
const CLIP_A = { start: 232, trimmed: 196 };
const CLIP_B = { start: 190, fast: 95 };
const TRIM = { start: 2200, end: 3400 };
const SPEED_AT = 3900;
const FADE_AT = 5200;
const AUDIO_AT = 6400;

const WAVES = Array.from({ length: 48 }, (_, i) => {
	const a = Math.sin(i * 0.7) * 0.5 + 0.5;
	const b = Math.sin(i * 1.9 + 1) * 0.5 + 0.5;
	return { key: `w${i}`, h: 0.25 + 0.7 * (0.5 * a + 0.5 * b) };
});

const clipsUiAt = (t: number) => ({
	speed: t >= SPEED_AT,
	fade: t >= FADE_AT,
	audio: t >= AUDIO_AT,
});

const clipWidthsAt = (t: number) => {
	const trim = easeInOut(span(t, TRIM.start, TRIM.end));
	const a = lerp(CLIP_A.start, CLIP_A.trimmed, trim);
	const b = t >= SPEED_AT ? CLIP_B.fast : CLIP_B.start;
	return { a, b };
};

const CLIPS_PATH: Way[] = [
	{ t: 0, x: 420, y: 120 },
	{ t: 1900, x: LANE_X + CLIP_A.start + 2, y: TRACK_Y + TRACK_H / 2 },
	{ t: TRIM.start, x: LANE_X + CLIP_A.start + 2, y: TRACK_Y + TRACK_H / 2 },
	{ t: TRIM.end, x: LANE_X + CLIP_A.trimmed + 2, y: TRACK_Y + TRACK_H / 2 },
	{
		t: SPEED_AT - 150,
		x: LANE_X + CLIP_A.trimmed + 6 + CLIP_B.start / 2,
		y: TRACK_Y + TRACK_H / 2,
	},
	{
		t: SPEED_AT,
		x: LANE_X + CLIP_A.trimmed + 6 + CLIP_B.start / 2,
		y: TRACK_Y + TRACK_H / 2,
		click: true,
	},
	{ t: FADE_AT - 150, x: LANE_X + CLIP_A.trimmed + 3, y: TRACK_Y - 6 },
	{ t: FADE_AT, x: LANE_X + CLIP_A.trimmed + 3, y: TRACK_Y - 6, click: true },
	{ t: AUDIO_AT + 400, x: 470, y: 150 },
	{ t: CLIPS_DURATION, x: 470, y: 150 },
];

export const ClipsVisual = ({ playing }: { playing: boolean }) => {
	const rootRef = useRef<HTMLDivElement | null>(null);
	const clipARef = useRef<HTMLDivElement | null>(null);
	const clipBRef = useRef<HTMLDivElement | null>(null);
	const seamRef = useRef<HTMLDivElement | null>(null);
	const playheadRef = useRef<HTMLDivElement | null>(null);
	const [ui, setUi] = useSceneState(clipsUiAt(0));
	const cursor = useCursor(rootRef);

	useLoop({
		duration: CLIPS_DURATION,
		playing,
		pose: 7200,
		tick: (t, seek) => {
			setUi(clipsUiAt(t));
			const { a, b } = clipWidthsAt(t);
			if (clipARef.current) clipARef.current.style.width = `${a}px`;
			if (clipBRef.current) {
				clipBRef.current.style.left = `${a + 6}px`;
				clipBRef.current.style.width = `${b}px`;
			}
			if (seamRef.current) seamRef.current.style.left = `${a - 6}px`;
			const frac = (t % 3200) / 3200;
			const fast = t >= SPEED_AT;
			const split = fast ? 0.66 : a / (a + b);
			const head =
				frac < split
					? lerp(0, a, frac / split)
					: lerp(a + 6, a + 6 + b, (frac - split) / (1 - split));
			if (playheadRef.current) {
				playheadRef.current.style.transform = `translateX(${head}px)`;
			}
			cursor.tick(CLIPS_PATH, t, seek);
		},
	});

	return (
		<div ref={rootRef} className="relative">
			<CanvasStage wallpaper="/backgrounds/sf.webp">
				<RecordedWindow left={170} top={22} width={280} height={162} />
				<CameraBubble playing={playing} size={56} left={130} top={130} />

				<div
					className="absolute z-10 rounded-[12px] p-4"
					style={{
						left: PANEL.x,
						top: PANEL.y,
						width: PANEL.w,
						height: PANEL.h,
						background: "#fcfcfc",
						border: "1px solid rgba(0,0,0,0.08)",
						boxShadow: "0 18px 40px -18px rgba(16,24,40,0.5)",
					}}
				>
					<div className="flex gap-2">
						<div style={{ width: GUTTER }} />
						<div
							className="relative h-[22px] flex-1 text-[9.5px]"
							style={{ color: "#8d8d8d" }}
						>
							{["0:00", "0:05", "0:10", "0:15", "0:20"].map((label, i) => (
								<span
									key={label}
									className="absolute top-0 flex -translate-x-1/2 flex-col items-center gap-0.5"
									style={{ left: `${(i / 4.4) * 100}%` }}
								>
									{label}
									<span className="size-[3px] rounded-full bg-current" />
								</span>
							))}
						</div>
					</div>

					<div className="mt-2 flex gap-2">
						<div
							className="flex shrink-0 items-center justify-center rounded-lg text-[10px] font-medium text-white"
							style={{
								width: GUTTER,
								height: TRACK_H,
								background: "#3f8ae0",
								border: "1px solid #2a5c96",
							}}
						>
							Video
						</div>
						<div className="relative flex-1" style={{ height: TRACK_H }}>
							<div
								ref={clipARef}
								className="absolute inset-y-0 left-0 overflow-hidden rounded-lg"
								style={{
									width: CLIP_A.start,
									background: "#3f8ae0",
									border: "1px solid #2a5c96",
								}}
							>
								<span className="absolute left-2 top-1.5 text-[9.5px] font-medium text-white/80">
									Clip 1
								</span>
								<span className="absolute inset-x-1 bottom-1 flex h-3 items-end gap-px">
									{WAVES.slice(0, 30).map((wave) => (
										<span
											key={wave.key}
											className="flex-1 rounded-[1px]"
											style={{
												height: `${wave.h * 100}%`,
												background: "rgba(255,255,255,0.45)",
											}}
										/>
									))}
								</span>
							</div>
							<div
								ref={clipBRef}
								className="absolute inset-y-0 overflow-hidden rounded-lg transition-[width] duration-500"
								style={{
									left: CLIP_A.start + 6,
									width: CLIP_B.start,
									background: "#3f8ae0",
									border: "1px solid #2a5c96",
								}}
							>
								<span className="absolute left-2 top-1.5 text-[9.5px] font-medium text-white/80">
									Clip 2
								</span>
								<span
									className={classNames(
										"absolute right-1.5 top-1 rounded-md px-1.5 py-0.5 text-[9.5px] font-semibold transition-opacity duration-300",
										ui.speed ? "opacity-100" : "opacity-0",
									)}
									style={{ background: "#ffffff", color: "#2563eb" }}
								>
									2×
								</span>
								<span className="absolute inset-x-1 bottom-1 flex h-3 items-end gap-px">
									{WAVES.slice(18, 40).map((wave) => (
										<span
											key={wave.key}
											className="flex-1 rounded-[1px]"
											style={{
												height: `${wave.h * 100}%`,
												background: "rgba(255,255,255,0.45)",
											}}
										/>
									))}
								</span>
							</div>
							<div
								ref={seamRef}
								className={classNames(
									"pointer-events-none absolute -top-1 -bottom-1 w-[18px] rounded-md transition-opacity duration-300",
									ui.fade ? "opacity-100" : "opacity-0",
								)}
								style={{
									left: CLIP_A.start - 6,
									background:
										"linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.85) 50%, rgba(255,255,255,0) 100%)",
									boxShadow: "0 0 18px 2px rgba(255,255,255,0.55)",
								}}
							>
								<span
									className="absolute -top-5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[9px] font-medium text-white"
									style={{ background: "#202020" }}
								>
									Crossfade
								</span>
							</div>
							<div
								ref={playheadRef}
								className="pointer-events-none absolute -top-2 bottom-0 left-0 will-change-transform"
							>
								<span
									className="absolute -left-[4px] top-0 size-[9px] rounded-full"
									style={{ background: "rgb(226,64,64)" }}
								/>
								<span
									className="absolute left-0 top-1 h-full w-px"
									style={{
										background:
											"linear-gradient(rgb(226,64,64), rgba(226,64,64,0.2))",
									}}
								/>
							</div>
						</div>
					</div>

					<div
						className={classNames(
							"mt-2 flex gap-2 transition-[opacity,transform] duration-500",
							ui.audio
								? "translate-y-0 opacity-100"
								: "translate-y-2 opacity-0",
						)}
					>
						<div
							className="flex shrink-0 items-center justify-center rounded-lg text-[10px] font-medium text-white"
							style={{
								width: GUTTER,
								height: 30,
								background: "#2f7a5b",
								border: "1px solid #1f5a42",
							}}
						>
							Audio
						</div>
						<div
							className="relative overflow-hidden rounded-lg"
							style={{
								width: LANE_W * 0.9,
								height: 30,
								background: "#dff3e9",
								border: "1px solid #bfe3d1",
							}}
						>
							<span
								className="absolute left-2 top-1 text-[9.5px] font-medium"
								style={{ color: "#0f7a58" }}
							>
								Lofi 03
							</span>
							<span className="absolute inset-x-1 bottom-1 flex h-2.5 items-end gap-px">
								{WAVES.map((wave) => (
									<span
										key={wave.key}
										className="flex-1 rounded-[1px]"
										style={{
											height: `${wave.h * 100}%`,
											background: "rgba(15,122,88,0.45)",
										}}
									/>
								))}
							</span>
						</div>
					</div>
				</div>
				{cursor.Cursor}
			</CanvasStage>
		</div>
	);
};
