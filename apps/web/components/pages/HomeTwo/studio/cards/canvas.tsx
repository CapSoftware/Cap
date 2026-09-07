"use client";

import { classNames } from "@cap/utils/helpers";
import Image from "next/image";
import { useRef } from "react";
import { useCursor, useSceneState, type Way } from "../../scenes/engine";
import {
	Chip,
	ED,
	EditorButton,
	Ground,
	Panel,
	RecordedWindow,
	Segmented,
	Slider,
	useLoop,
} from "../shared";

/* Any canvas, one recording: the editor's real Background section along
 * the bottom (source pill, wallpaper categories, the Cities row, Padding
 * and Corners) and the canvas result above it. The wallpaper appears only
 * as a swatch and as the picked background, never as scenery. */

const SOURCES = [
	"Desktop",
	"Wallpaper",
	"Image",
	"Color",
	"Gradient",
	"Animated",
] as const;
const CATEGORIES = ["macOS", "Dark", "Blue", "Cities", "Purple", "Orange"];
const CITIES = ["liverpool", "santorini", "miami", "monaco", "london", "rome"];
const GRADIENTS = [
	"linear-gradient(135deg, #FF7E5F 0%, #FEB47B 100%)",
	"linear-gradient(135deg, #667EEA 0%, #764BA2 100%)",
	"linear-gradient(135deg, #43CEA2 0%, #185A9D 100%)",
	"linear-gradient(135deg, #F857A6 0%, #FF5858 100%)",
	"linear-gradient(135deg, #1FA2FF 0%, #12D8FA 55%, #A6FFCB 100%)",
	"linear-gradient(135deg, #0F2027 0%, #203A43 50%, #2C5364 100%)",
];

const WALL_FROM = 3;
const WALL_TO = 1;
const GRADIENT_TO = 1;

const DURATION = 10000;
const WALL_AT = 1400;
const GRADIENT_AT = 3600;
const SWATCH_AT = 4600;
const BROWSER_AT = 5800;
const MACBOOK_AT = 7600;
const UNFRAME_AT = 9400;

const S = 1.15;
const PANEL = { left: 12, top: 211, w: 500, pad: 12 } as const;
const ROW = { pill: 12, chips: 52, grid: 84 } as const;
const THUMB = { w: 34, h: 34, gap: 6 } as const;
const RESULT = { w: 336, h: 189, left: 114, top: 12 } as const;
const WIN_SCALE = 0.46;
const WIN = {
	left: Math.round((RESULT.w - 360 * WIN_SCALE) / 2),
	top: 46,
} as const;

const toCanvas = (x: number, y: number) => ({
	x: PANEL.left + x * S,
	y: PANEL.top + y * S,
});
const thumbCenter = (i: number) =>
	toCanvas(
		PANEL.pad + i * (THUMB.w + THUMB.gap) + THUMB.w / 2,
		ROW.grid + THUMB.h / 2,
	);
const pillCenter = (i: number) => {
	const inner = PANEL.w - PANEL.pad * 2 - 4;
	const item = (inner - 10) / 6;
	return toCanvas(PANEL.pad + 2 + item * (i + 0.5) + 2 * i, ROW.pill + 15);
};

const PATH: Way[] = [
	{ t: 0, x: 380, y: 130 },
	{ t: WALL_AT - 500, ...thumbCenter(WALL_TO) },
	{ t: WALL_AT, ...thumbCenter(WALL_TO), click: true },
	{ t: GRADIENT_AT - 600, ...pillCenter(4) },
	{ t: GRADIENT_AT, ...pillCenter(4), click: true },
	{ t: SWATCH_AT - 400, ...thumbCenter(GRADIENT_TO) },
	{ t: SWATCH_AT, ...thumbCenter(GRADIENT_TO), click: true },
	{ t: SWATCH_AT + 900, x: 470, y: 150 },
	{ t: DURATION, x: 470, y: 150 },
];

type Frame = "none" | "browser" | "macbook";

const uiAt = (t: number) => {
	const source = t >= GRADIENT_AT ? "Gradient" : "Wallpaper";
	const wall = t >= WALL_AT ? WALL_TO : WALL_FROM;
	const gradient = t >= SWATCH_AT ? GRADIENT_TO : 0;
	const frame: Frame =
		t >= UNFRAME_AT
			? "none"
			: t >= MACBOOK_AT
				? "macbook"
				: t >= BROWSER_AT
					? "browser"
					: "none";
	return { source, wall, gradient, frame };
};

const title = (city: string) => city.charAt(0).toUpperCase() + city.slice(1);

const MiniField = ({
	label,
	value,
	fill,
}: {
	label: string;
	value: string;
	fill: number;
}) => (
	<div className="flex h-[26px] items-center gap-2">
		<span
			className="w-[54px] shrink-0 text-[13px] font-normal"
			style={{ color: ED.text1 }}
		>
			{label}
		</span>
		<div className="min-w-0 flex-1">
			<Slider fill={fill} />
		</div>
		<span
			className="min-w-8 text-right text-[11px] tabular-nums"
			style={{ color: ED.text3 }}
		>
			{value}
		</span>
	</div>
);

const Swatch = ({
	selected,
	children,
}: {
	selected: boolean;
	children: React.ReactNode;
}) => (
	<span
		className={classNames(
			"relative block overflow-hidden rounded-md transition-shadow duration-200",
			selected && "ring-2 ring-offset-2",
		)}
		style={{
			width: THUMB.w,
			height: THUMB.h,
			["--tw-ring-color" as string]: ED.accent,
			["--tw-ring-offset-color" as string]: ED.card,
		}}
	>
		{children}
	</span>
);

export const Visual = ({ playing }: { playing: boolean }) => {
	const rootRef = useRef<HTMLDivElement | null>(null);
	const [ui, setUi] = useSceneState(uiAt(0));
	const cursor = useCursor(rootRef);

	useLoop({
		duration: DURATION,
		playing,
		pose: 2400,
		tick: (t, seek) => {
			setUi(uiAt(t));
			cursor.tick(PATH, t, seek);
		},
	});

	const wallpaper = ui.source === "Wallpaper";
	const browser = ui.frame === "browser";
	const macbook = ui.frame === "macbook";
	const label =
		ui.frame === "browser"
			? "Frame · Browser"
			: ui.frame === "macbook"
				? "Frame · MacBook"
				: wallpaper
					? `Wallpaper · ${title(CITIES[ui.wall] ?? "")}`
					: "Gradient";

	return (
		<div ref={rootRef} className="relative">
			<Ground tone="light">
				<div
					className="absolute overflow-hidden rounded-[10px]"
					style={{
						left: RESULT.left,
						top: RESULT.top,
						width: RESULT.w,
						height: RESULT.h,
						boxShadow:
							"0 12px 32px -8px rgba(0,0,0,0.35), 0 0 0 0.5px rgba(0,0,0,0.12)",
					}}
				>
					{[WALL_FROM, WALL_TO].map((index) => (
						<Image
							key={CITIES[index]}
							src={`/backgrounds/${CITIES[index]}.webp`}
							alt=""
							fill
							sizes="336px"
							draggable={false}
							className="object-cover transition-opacity duration-700"
							style={{ opacity: wallpaper && ui.wall === index ? 1 : 0 }}
						/>
					))}
					<div
						className="absolute inset-0 transition-opacity duration-700"
						style={{
							background: GRADIENTS[ui.gradient],
							opacity: wallpaper ? 0 : 1,
						}}
					/>

					<div
						className="absolute"
						style={{
							left: WIN.left,
							top: WIN.top,
							width: 360 * WIN_SCALE,
							height: 250 * WIN_SCALE,
						}}
					>
						<div
							className="absolute left-0 top-0"
							style={{
								width: 360,
								height: 250,
								transform: `scale(${WIN_SCALE})`,
								transformOrigin: "top left",
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
									background:
										"linear-gradient(180deg, #2b2d33 0%, #101114 12%)",
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
					</div>
				</div>

				<div
					className="absolute z-20"
					style={{ left: RESULT.left + 10, top: RESULT.top + 6 }}
				>
					<Chip className="h-6">
						<span
							className="size-2 rounded-full"
							style={{ background: ED.accent }}
						/>
						{label}
					</Chip>
				</div>

				<Panel
					className="z-30 gap-0"
					style={{
						left: PANEL.left,
						top: PANEL.top,
						width: PANEL.w,
						padding: PANEL.pad,
						transform: `scale(${S})`,
						transformOrigin: "top left",
					}}
				>
					<Segmented options={SOURCES} value={ui.source} />

					<div className="mt-2.5 flex h-6 items-center justify-between">
						{wallpaper ? (
							<div className="flex items-center gap-1">
								{CATEGORIES.map((category) => {
									const on = category === "Cities";
									return (
										<span
											key={category}
											className="flex h-6 items-center rounded-[7px] px-2.5 text-[12px] font-medium"
											style={{
												background: on ? ED.ctlHover : "transparent",
												color: on ? ED.text1 : ED.text2,
											}}
										>
											{category}
										</span>
									);
								})}
							</div>
						) : (
							<>
								<span
									className="text-[12px] font-medium"
									style={{ color: ED.text2 }}
								>
									Presets
								</span>
								<EditorButton className="h-6 text-[12px]">
									Randomize
								</EditorButton>
							</>
						)}
					</div>

					<div className="mt-2 flex items-start gap-4">
						<div
							className="grid shrink-0 grid-cols-6"
							style={{ gap: THUMB.gap }}
						>
							{wallpaper
								? CITIES.map((city, i) => (
										<Swatch key={city} selected={ui.wall === i}>
											<Image
												src={`/backgrounds/thumbs/${city}.webp`}
												alt=""
												width={THUMB.w}
												height={THUMB.h}
												draggable={false}
												className="h-full w-full object-cover"
											/>
										</Swatch>
									))
								: GRADIENTS.map((gradient, i) => (
										<Swatch key={gradient} selected={ui.gradient === i}>
											<span
												className="block h-full w-full"
												style={{ background: gradient }}
											/>
										</Swatch>
									))}
						</div>
						<div className="flex min-w-0 flex-1 flex-col">
							{wallpaper ? (
								<>
									<MiniField label="Padding" value="10%" fill={0.25} />
									<MiniField label="Corners" value="7.5%" fill={0.075} />
								</>
							) : (
								<>
									<MiniField label="Angle" value="90°" fill={0.25} />
									<MiniField label="Noise" value="0" fill={0} />
								</>
							)}
						</div>
					</div>
				</Panel>
				{cursor.Cursor}
			</Ground>
		</div>
	);
};
