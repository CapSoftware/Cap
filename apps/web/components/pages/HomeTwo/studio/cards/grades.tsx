"use client";

import { classNames } from "@cap/utils/helpers";
import { useRef } from "react";
import {
	easeOut,
	span,
	useCursor,
	useSceneState,
	type Way,
} from "../../scenes/engine";
import {
	CANVAS,
	ED,
	Field,
	Ground,
	Panel,
	RecordedWindow,
	SectionTitle,
	Slider,
	useLoop,
} from "../shared";

/* Color grades: a before/after wipe across the whole frame (background
 * included) each time a preset is picked in the editor's real
 * "Color correction" section. */

type Grade = { name: string; filter: string; tint: string };

const GRADES: Grade[] = [
	{ name: "None", filter: "none", tint: "transparent" },
	{
		name: "Cinematic",
		filter: "contrast(1.15) saturate(0.82) sepia(0.12)",
		tint: "rgba(24,52,92,0.18)",
	},
	{
		name: "Noir",
		filter: "grayscale(1) contrast(1.25) brightness(0.96)",
		tint: "rgba(0,0,0,0.08)",
	},
	{
		name: "Vintage",
		filter: "sepia(0.45) contrast(0.95) brightness(1.04) saturate(0.9)",
		tint: "rgba(255,196,120,0.16)",
	},
	{
		name: "Frost",
		filter: "saturate(0.75) brightness(1.06) hue-rotate(-8deg)",
		tint: "rgba(168,208,255,0.24)",
	},
	{
		name: "Golden",
		filter: "sepia(0.3) saturate(1.2) brightness(1.03)",
		tint: "rgba(255,186,74,0.2)",
	},
	{
		name: "Midnight",
		filter: "brightness(0.82) contrast(1.15) saturate(0.9) hue-rotate(12deg)",
		tint: "rgba(22,30,86,0.3)",
	},
	{
		name: "Vivid",
		filter: "saturate(1.55) contrast(1.08)",
		tint: "transparent",
	},
	{
		name: "Dreamy",
		filter: "brightness(1.08) contrast(0.88) saturate(1.15)",
		tint: "rgba(255,190,230,0.18)",
	},
];

const GROUND_GRADIENT =
	"linear-gradient(135deg, #C3DCF8 0%, #DACBF9 55%, #F6D9EC 100%)";

const DURATION = 9600;
const STOPS: { name: string; at: number }[] = [
	{ name: "Cinematic", at: 1000 },
	{ name: "Noir", at: 2400 },
	{ name: "Golden", at: 3800 },
	{ name: "Midnight", at: 5200 },
	{ name: "Vivid", at: 6600 },
	{ name: "Dreamy", at: 8000 },
];
const SWEEP = 900;
const WIPE_MAX = 0.52;

const WIN = { left: 10, top: 46, scale: 0.95 } as const;
const S = 1.3;
const PANEL = { w: 190, pad: 12 } as const;
const PANEL_POS = { left: CANVAS.w - PANEL.w * S - 12, top: 18 } as const;
const SWATCH = { w: 50, h: 28, gap: 8, label: 14 } as const;
const GRID_TOP = PANEL.pad + 22 + 10;

const swatchCenter = (index: number) => {
	const row = Math.floor(index / 3);
	const col = index % 3;
	return {
		x:
			PANEL_POS.left +
			(PANEL.pad + col * (SWATCH.w + SWATCH.gap) + SWATCH.w / 2) * S,
		y:
			PANEL_POS.top +
			(GRID_TOP + row * (SWATCH.h + SWATCH.label + SWATCH.gap) + SWATCH.h / 2) *
				S,
	};
};

const PATH: Way[] = [
	{ t: 0, x: 300, y: 330 },
	...STOPS.flatMap((stop) => {
		const point = swatchCenter(GRADES.findIndex((g) => g.name === stop.name));
		return [
			{ t: stop.at - 220, ...point },
			{ t: stop.at, ...point, click: true },
		];
	}),
	{ t: DURATION - 700, x: 290, y: 330 },
	{ t: DURATION, x: 290, y: 330 },
];

const gradeAt = (t: number) => {
	let current = "None";
	for (const stop of STOPS) if (t >= stop.at) current = stop.name;
	return current;
};

const wipeAt = (t: number) => {
	let latest: (typeof STOPS)[number] | undefined;
	for (const stop of STOPS) if (t >= stop.at) latest = stop;
	if (!latest) return 0;
	return easeOut(span(t, latest.at, latest.at + SWEEP)) * WIPE_MAX;
};

const Scene = ({ grade }: { grade: Grade }) => (
	<span
		className="relative block overflow-hidden rounded-md"
		style={{
			width: SWATCH.w,
			height: SWATCH.h,
			background:
				"linear-gradient(160deg, #f7c27a 0%, #e98a9c 45%, #5a7fd8 100%)",
			filter: grade.filter,
		}}
	>
		<span
			className="absolute rounded-full"
			style={{
				left: 8,
				top: 6,
				width: 9,
				height: 9,
				background: "#fff4d6",
				boxShadow: "0 0 6px rgba(255,244,214,0.9)",
			}}
		/>
		<span
			className="absolute inset-x-0 bottom-0"
			style={{ height: 9, background: "rgba(26,32,64,0.55)" }}
		/>
		<span
			className="absolute inset-0"
			style={{ background: grade.tint, mixBlendMode: "multiply" }}
		/>
	</span>
);

export const Visual = ({ playing }: { playing: boolean }) => {
	const rootRef = useRef<HTMLDivElement | null>(null);
	const gradedRef = useRef<HTMLDivElement | null>(null);
	const lineRef = useRef<HTMLDivElement | null>(null);
	const [ui, setUi] = useSceneState({ grade: "None" });
	const cursor = useCursor(rootRef);

	useLoop({
		duration: DURATION,
		playing,
		pose: 4600,
		tick: (t, seek) => {
			setUi({ grade: gradeAt(t) });
			const wipe = wipeAt(t);
			if (gradedRef.current) {
				gradedRef.current.style.clipPath = `inset(0 ${(1 - wipe) * 100}% 0 0)`;
			}
			if (lineRef.current) {
				lineRef.current.style.transform = `translateX(${wipe * CANVAS.w}px)`;
				lineRef.current.style.opacity = wipe > 0.005 ? "1" : "0";
			}
			cursor.tick(PATH, t, seek);
		},
	});

	const grade = GRADES.find((item) => item.name === ui.grade) ?? GRADES[0];
	const graded = grade?.name !== "None";

	return (
		<div ref={rootRef} className="relative">
			<Ground tone="gradient">
				<RecordedWindow left={WIN.left} top={WIN.top} scale={WIN.scale} />

				<div
					ref={gradedRef}
					className="pointer-events-none absolute inset-0 transition-[filter] duration-500"
					style={{
						clipPath: "inset(0 100% 0 0)",
						filter: grade?.filter,
					}}
				>
					<div
						className="absolute inset-0"
						style={{ background: GROUND_GRADIENT }}
					/>
					<RecordedWindow left={WIN.left} top={WIN.top} scale={WIN.scale} />
					<div
						className="absolute inset-0 transition-[background-color] duration-500"
						style={{ background: grade?.tint, mixBlendMode: "multiply" }}
					/>
					<div
						className="absolute inset-0"
						style={{
							background:
								"radial-gradient(85% 75% at 50% 50%, rgba(9,12,20,0) 55%, rgba(9,12,20,0.45) 100%)",
						}}
					/>
				</div>

				<div
					ref={lineRef}
					className="pointer-events-none absolute inset-y-0 left-0 z-20 w-px opacity-0 transition-opacity duration-300 will-change-transform"
					style={{
						background: "rgba(255,255,255,0.95)",
						boxShadow: "0 0 0 1px rgba(0,0,0,0.12)",
					}}
				>
					<span
						className="absolute left-1/2 top-1/2 flex size-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full"
						style={{
							background: "#ffffff",
							boxShadow: "0 4px 14px rgba(0,0,0,0.25)",
						}}
					>
						<svg
							aria-hidden="true"
							viewBox="0 0 16 16"
							className="size-3"
							fill="none"
							stroke={ED.text1}
							strokeWidth="1.6"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<path d="M6 4 2 8l4 4M10 4l4 4-4 4" />
						</svg>
					</span>
				</div>

				<div
					className="absolute z-20 flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium transition-opacity duration-300"
					style={{
						left: 20,
						top: 10,
						background: ED.card,
						color: ED.text1,
						boxShadow: ED.popShadow,
						opacity: graded ? 1 : 0,
					}}
				>
					<span
						className="size-2 rounded-full"
						style={{ background: ED.accent }}
					/>
					{grade?.name}
				</div>

				<Panel
					className="z-30 gap-2.5"
					style={{
						left: PANEL_POS.left,
						top: PANEL_POS.top,
						width: PANEL.w,
						padding: PANEL.pad,
						transform: `scale(${S})`,
						transformOrigin: "top left",
					}}
				>
					<SectionTitle>Color correction</SectionTitle>
					<div
						className="grid grid-cols-3"
						style={{ gap: SWATCH.gap, rowGap: SWATCH.gap }}
					>
						{GRADES.map((item) => {
							const selected = ui.grade === item.name;
							return (
								<span
									key={item.name}
									className="flex flex-col items-start gap-0.5"
								>
									<span
										className={classNames(
											"rounded-md transition-shadow duration-200",
											selected && "ring-2 ring-offset-2",
										)}
										style={{
											boxShadow: selected
												? undefined
												: `0 0 0 0.5px ${ED.line}`,
											["--tw-ring-color" as string]: ED.accent,
											["--tw-ring-offset-color" as string]: ED.card,
										}}
									>
										<Scene grade={item} />
									</span>
									<span
										className="text-[10px] leading-[14px]"
										style={{ color: selected ? ED.text1 : ED.text2 }}
									>
										{item.name}
									</span>
								</span>
							);
						})}
					</div>
					<Field label="Grain" value="0%">
						<Slider fill={0} />
					</Field>
				</Panel>
				{cursor.Cursor}
			</Ground>
		</div>
	);
};
