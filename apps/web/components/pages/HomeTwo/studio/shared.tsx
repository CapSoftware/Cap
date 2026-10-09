"use client";

import { classNames } from "@cap/utils/helpers";
import {
	type ComponentType,
	type CSSProperties,
	type ReactNode,
	type RefObject,
	useEffect,
	useRef,
} from "react";
import { ContentWindow } from "../demo/MacDesktop";
import { useVideoAttrs, VIDEO_POSTERS } from "../demo/media";
import { SCENE_CSS, useVideo } from "../scenes/engine";
import { useReducedMotion } from "../visibility";

export type StudioCard = {
	key: string;
	title: string;
	body: string;
	Visual: ComponentType<{ playing: boolean }>;
};

export const CANVAS = { w: 600, h: 375 } as const;

// Mirrors the desktop editor's ed-* light tokens (apps/desktop/src/styles/theme.css) and
// Timeline/styles.css; keep in sync when the editor theme changes.
export const ED = {
	window: "#f1f1f3",
	card: "#ffffff",
	card2: "#f6f6f7",
	stage: "#e9e9ec",
	line: "rgba(0,0,0,0.075)",
	lineStrong: "rgba(0,0,0,0.12)",
	text1: "#1c1c1e",
	text2: "#6e6e75",
	text3: "#a0a0a8",
	ctl: "rgba(0,0,0,0.045)",
	ctlHover: "rgba(0,0,0,0.075)",
	ctlActive: "rgba(0,0,0,0.11)",
	accent: "#007aff",
	playhead: "#ff3b30",
	cardShadow: "0 1px 2px rgba(0,0,0,0.04), 0 0 0 1px rgba(0,0,0,0.075)",
	popShadow: "0 12px 32px -12px rgba(0,0,0,0.25), 0 0 0 1px rgba(0,0,0,0.075)",
} as const;

export const HUE = {
	clip: "#3b82f6",
	zoom: "#64748b",
	caption: "#0ea5e9",
	text: "#14b8a6",
	mask: "#ef4444",
	scene: "#8b5cf6",
	audio: "#22c55e",
	threeD: "#6366f1",
} as const;

export const mix = (hue: string, pct: number, base = "#ffffff") =>
	`color-mix(in srgb, ${hue} ${pct}%, ${base})`;

export const useLoop = ({
	duration,
	playing,
	pose,
	tick,
}: {
	duration: number;
	playing: boolean;
	pose: number;
	tick: (t: number, seek: boolean) => void;
}) => {
	const tRef = useRef(0);
	const tickRef = useRef(tick);
	tickRef.current = tick;
	const reduced = useReducedMotion();

	useEffect(() => {
		if (reduced) {
			tickRef.current(pose, true);
			return;
		}
		if (!playing) return;
		let raf = 0;
		let last = performance.now();
		let seek = true;
		const frame = (now: number) => {
			const dt = Math.min(48, now - last);
			last = now;
			const next = tRef.current + dt;
			if (next >= duration) seek = true;
			tRef.current = next % duration;
			tickRef.current(tRef.current, seek);
			seek = false;
			raf = requestAnimationFrame(frame);
		};
		raf = requestAnimationFrame(frame);
		return () => cancelAnimationFrame(raf);
	}, [playing, reduced, duration, pose]);
};

export type Tone = "light" | "chrome" | "dark" | "gradient";

const GROUND_BG: Record<Tone, string> = {
	light: "#F4F6F9",
	chrome: ED.window,
	dark: "#141518",
	gradient: "linear-gradient(135deg, #C3DCF8 0%, #DACBF9 55%, #F6D9EC 100%)",
};

export const Ground = ({
	tone = "light",
	className,
	style,
	children,
}: {
	tone?: Tone;
	className?: string;
	style?: CSSProperties;
	children: ReactNode;
}) => (
	<div
		className={classNames("relative overflow-hidden", className)}
		style={{
			width: CANVAS.w,
			height: CANVAS.h,
			background: GROUND_BG[tone],
			color: tone === "dark" ? "#ffffff" : ED.text1,
			...style,
		}}
	>
		<style>{SCENE_CSS}</style>
		{children}
	</div>
);

export const RECORDED = {
	left: 120,
	top: 62,
	width: 360,
	height: 250,
} as const;

export const RecordedWindow = ({
	left = RECORDED.left,
	top = RECORDED.top,
	width = RECORDED.width,
	height = RECORDED.height,
	scale = 1,
	className,
	style,
}: {
	left?: number;
	top?: number;
	width?: number;
	height?: number;
	scale?: number;
	className?: string;
	style?: CSSProperties;
}) => {
	const scrollRef = useRef<HTMLDivElement | null>(null);
	return (
		<div
			className={classNames("absolute", className)}
			style={{
				left,
				top,
				width,
				height,
				transform: scale === 1 ? undefined : `scale(${scale})`,
				transformOrigin: "top left",
				...style,
			}}
		>
			<ContentWindow width={width} height={height} scrollRef={scrollRef} />
		</div>
	);
};

export const CameraBubble = ({
	playing,
	size = 96,
	left = 24,
	top = CANVAS.h - 24 - 96,
	className,
	style,
}: {
	playing: boolean;
	size?: number;
	left?: number;
	top?: number;
	className?: string;
	style?: CSSProperties;
}) => {
	const ref = useRef<HTMLVideoElement | null>(null);
	const attrs = useVideoAttrs(VIDEO_POSTERS.webcam);
	useVideo(playing, ref);
	return (
		<div
			className={classNames(
				"absolute overflow-hidden rounded-full bg-[#111111]",
				className,
			)}
			style={{
				left,
				top,
				width: size,
				height: size,
				boxShadow: "0 10px 26px rgba(0,0,0,0.35)",
				...style,
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

export const Chip = ({
	children,
	className,
	style,
}: {
	children: ReactNode;
	className?: string;
	style?: CSSProperties;
}) => (
	<span
		className={classNames(
			"inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium",
			className,
		)}
		style={{
			background: ED.card,
			color: ED.text1,
			boxShadow: ED.popShadow,
			...style,
		}}
	>
		{children}
	</span>
);

export const Panel = ({
	className,
	style,
	children,
}: {
	className?: string;
	style?: CSSProperties;
	children: ReactNode;
}) => (
	<div
		className={classNames(
			"absolute flex flex-col gap-3.5 rounded-xl p-4",
			className,
		)}
		style={{ background: ED.card, boxShadow: ED.popShadow, ...style }}
	>
		{children}
	</div>
);

export const SectionTitle = ({
	children,
	right,
}: {
	children: ReactNode;
	right?: ReactNode;
}) => (
	<div className="flex min-h-[22px] items-center justify-between">
		<span className="text-[12px] font-medium" style={{ color: ED.text2 }}>
			{children}
		</span>
		{right}
	</div>
);

export const Field = ({
	label,
	value,
	badge,
	disabled,
	children,
}: {
	label: ReactNode;
	value?: ReactNode;
	badge?: ReactNode;
	disabled?: boolean;
	children?: ReactNode;
}) => (
	<div className="flex flex-col gap-2">
		<div className="flex items-center gap-1.5">
			<span
				className="text-[13px] font-normal"
				style={{ color: disabled ? ED.text3 : ED.text1 }}
			>
				{label}
			</span>
			{badge ? (
				<span
					className="rounded-full px-1.5 py-0.5 text-[10px] font-medium"
					style={{ background: ED.ctl, color: ED.text2 }}
				>
					{badge}
				</span>
			) : null}
			{value !== undefined ? (
				<span
					className="ml-auto min-w-9 text-right text-[11px] tabular-nums"
					style={{ color: ED.text3 }}
				>
					{value}
				</span>
			) : null}
		</div>
		{children}
	</div>
);

export const InlineField = ({
	label,
	value,
	children,
}: {
	label: ReactNode;
	value?: ReactNode;
	children?: ReactNode;
}) => (
	<div className="flex h-[34px] items-center gap-3">
		<span
			className="min-w-24 shrink-0 text-[13px] font-normal"
			style={{ color: ED.text1 }}
		>
			{label}
		</span>
		<div className="flex flex-1 items-center justify-end gap-2">
			{children}
			{value !== undefined ? (
				<span
					className="min-w-9 text-right text-[11px] tabular-nums"
					style={{ color: ED.text3 }}
				>
					{value}
				</span>
			) : null}
		</div>
	</div>
);

export const Slider = ({
	fill,
	className,
}: {
	fill: number;
	className?: string;
}) => (
	<div className={classNames("relative flex h-8 items-center px-1", className)}>
		<div
			className="h-[3px] w-full overflow-hidden rounded-full"
			style={{ background: ED.ctlActive }}
		>
			<div
				className="h-full rounded-full transition-[width] duration-300 ease-out"
				style={{ width: `${fill * 100}%`, background: ED.accent }}
			/>
		</div>
		<span
			className="absolute size-3.5 rounded-full transition-[left] duration-300 ease-out"
			style={{
				left: `calc(4px + (100% - 8px) * ${fill} - 7px)`,
				background: "#ffffff",
				boxShadow: "0 1px 3px rgba(0,0,0,0.25), 0 0 0 0.5px rgba(0,0,0,0.1)",
			}}
		/>
	</div>
);

export const Segmented = ({
	options,
	value,
	itemWidth,
	disabled,
	className,
	style,
}: {
	options: readonly string[];
	value: string | null;
	itemWidth?: number;
	disabled?: boolean;
	className?: string;
	style?: CSSProperties;
}) => (
	<div
		className={classNames(
			"flex gap-0.5 rounded-lg p-0.5 transition-opacity duration-200",
			disabled && "opacity-50",
			className,
		)}
		style={{ background: ED.ctl, ...style }}
	>
		{options.map((option) => {
			const on = value === option;
			return (
				<span
					key={option}
					className="flex h-[26px] flex-1 items-center justify-center whitespace-nowrap rounded-md px-3 text-[11.5px] font-medium transition-[background-color,color,box-shadow] duration-200"
					style={{
						width: itemWidth,
						background: on ? ED.card : "transparent",
						color: on ? ED.text1 : ED.text2,
						boxShadow: on
							? "0 1px 2px rgba(0,0,0,0.12), 0 0 0 0.5px rgba(0,0,0,0.06)"
							: undefined,
					}}
				>
					{option}
				</span>
			);
		})}
	</div>
);

export const Toggle = ({ on }: { on: boolean }) => (
	<span
		className="relative inline-flex h-6 w-11 shrink-0 rounded-full p-0.5 transition-colors duration-200"
		style={{ background: on ? ED.accent : ED.ctlActive }}
	>
		<span
			className="absolute top-0.5 size-5 rounded-full bg-white transition-[left] duration-200"
			style={{
				left: on ? 22 : 2,
				boxShadow: "0 1px 3px rgba(0,0,0,0.22)",
			}}
		/>
	</span>
);

export const EditorButton = ({
	children,
	primary,
	className,
	style,
}: {
	children: ReactNode;
	primary?: boolean;
	className?: string;
	style?: CSSProperties;
}) => (
	<span
		className={classNames(
			"inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-[7px] px-2.5 text-[13px] font-medium",
			className,
		)}
		style={{
			background: primary ? ED.accent : ED.ctl,
			color: primary ? "#ffffff" : ED.text1,
			...style,
		}}
	>
		{children}
	</span>
);

export const Tile = ({
	selected,
	children,
	className,
	style,
}: {
	selected?: boolean;
	children: ReactNode;
	className?: string;
	style?: CSSProperties;
}) => (
	<span
		className={classNames(
			"flex h-[30px] items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-[11.5px] font-medium transition-colors duration-200",
			className,
		)}
		style={{
			background: selected ? ED.ctlHover : ED.ctl,
			color: selected ? ED.text1 : ED.text2,
			...style,
		}}
	>
		{children}
	</span>
);

export const TRACK_H = 44;
export const TRACK_GAP = 6;
export const TRACK_GUTTER = 96;
export const RULER_H = 26;

export const TrackLabel = ({
	hue,
	icon,
	children,
	style,
}: {
	hue: string;
	icon?: ReactNode;
	children: ReactNode;
	style?: CSSProperties;
}) => (
	<div
		className="flex shrink-0 items-center gap-2"
		style={{ width: TRACK_GUTTER, height: TRACK_H, ...style }}
	>
		<span
			className="grid size-[22px] shrink-0 place-items-center rounded-md"
			style={{
				background: mix(hue, 16, "transparent"),
				color: mix(hue, 62, "#000000"),
			}}
		>
			{icon ? <span className="size-3.5">{icon}</span> : null}
		</span>
		<span
			className="truncate text-[11px] font-medium"
			style={{ color: ED.text2 }}
		>
			{children}
		</span>
	</div>
);

export const Lane = ({
	empty,
	className,
	style,
	children,
}: {
	empty?: ReactNode;
	className?: string;
	style?: CSSProperties;
	children?: ReactNode;
}) => (
	<div
		className={classNames("relative flex-1", className)}
		style={{ height: TRACK_H, ...style }}
	>
		{empty ? (
			<div
				className="absolute inset-0 flex items-center justify-center gap-1.5 rounded-lg border border-dashed text-[12px]"
				style={{ borderColor: ED.lineStrong, color: ED.text3 }}
			>
				{empty}
			</div>
		) : null}
		{children}
	</div>
);

export const Segment = ({
	hue,
	label,
	sublabel,
	trailing,
	selected,
	segmentRef,
	className,
	style,
	children,
}: {
	hue: string;
	label?: ReactNode;
	sublabel?: ReactNode;
	trailing?: ReactNode;
	selected?: boolean;
	segmentRef?: RefObject<HTMLDivElement | null>;
	className?: string;
	style?: CSSProperties;
	children?: ReactNode;
}) => (
	<div
		ref={segmentRef}
		className={classNames(
			"absolute inset-y-0 overflow-hidden rounded-lg",
			className,
		)}
		style={{
			background: mix(hue, selected ? 23 : 13),
			boxShadow: selected
				? `inset 0 0 0 1.5px ${ED.accent}`
				: `inset 0 0 0 1px ${mix(hue, 34, "transparent")}`,
			...style,
		}}
	>
		<span
			className="absolute inset-y-0 left-0 w-[3px]"
			style={{ background: hue }}
		/>
		{label !== undefined ? (
			<span className="absolute left-[13px] top-1/2 flex -translate-y-1/2 items-center gap-2 whitespace-nowrap">
				<span
					className="text-[12px] font-medium"
					style={{ color: mix(hue, 58, "#000000") }}
				>
					{label}
				</span>
				{sublabel !== undefined ? (
					<span
						className="text-[11px] tabular-nums"
						style={{ color: mix(hue, 45, ED.text3) }}
					>
						{sublabel}
					</span>
				) : null}
				{trailing}
			</span>
		) : null}
		{children}
	</div>
);

export const Ruler = ({
	labels,
	span: total,
	className,
	style,
}: {
	labels: string[];
	span: number;
	className?: string;
	style?: CSSProperties;
}) => (
	<div
		className={classNames(
			"relative flex-1 text-[11px] tabular-nums",
			className,
		)}
		style={{ height: RULER_H, color: ED.text3, ...style }}
	>
		{labels.map((label, i) => (
			<span
				key={label}
				className={classNames(
					"absolute top-1 flex flex-col gap-1",
					i === 0 ? "items-start" : "-translate-x-1/2 items-center",
				)}
				style={{ left: `${(i / total) * 100}%` }}
			>
				<span>{label}</span>
				<span className="h-1 w-px" style={{ background: ED.lineStrong }} />
			</span>
		))}
	</div>
);

export const Playhead = ({
	playheadRef,
	top = 0,
	bottom = 0,
	left = 0,
}: {
	playheadRef: RefObject<HTMLDivElement | null>;
	top?: number;
	bottom?: number;
	left?: number;
}) => (
	<div
		ref={playheadRef}
		className="pointer-events-none absolute z-20 will-change-transform"
		style={{ top, bottom, left }}
	>
		<span
			className="absolute -left-[6px] top-0 size-3 rounded-full"
			style={{ background: ED.playhead, boxShadow: `0 0 0 2px ${ED.card}` }}
		/>
		<span
			className="absolute left-0 top-1.5 h-full w-px"
			style={{ background: ED.playhead }}
		/>
	</div>
);

export const WAVES = Array.from({ length: 64 }, (_, i) => {
	const a = Math.sin(i * 0.7) * 0.5 + 0.5;
	const b = Math.sin(i * 1.9 + 1) * 0.5 + 0.5;
	return { key: `w${i}`, h: 0.25 + 0.7 * (0.5 * a + 0.5 * b) };
});

export const Waveform = ({
	from = 0,
	to = WAVES.length,
	color,
	className,
}: {
	from?: number;
	to?: number;
	color?: string;
	className?: string;
}) => (
	<span
		className={classNames(
			"absolute inset-x-2 bottom-0 flex h-[18px] items-end gap-px",
			className,
		)}
	>
		{WAVES.slice(from, to).map((wave) => (
			<span
				key={wave.key}
				className="flex-1 rounded-[1px]"
				style={{
					height: `${wave.h * 100}%`,
					background: color ?? mix(HUE.clip, 45, "transparent"),
				}}
			/>
		))}
	</span>
);

export const SpeedChip = ({
	children,
	active,
	className,
}: {
	children: ReactNode;
	active?: boolean;
	className?: string;
}) => (
	<span
		className={classNames(
			"inline-flex h-4 items-center rounded-full px-1.5 text-[10px] font-medium leading-none transition-colors duration-300",
			className,
		)}
		style={{
			background: active ? ED.accent : ED.ctlActive,
			color: active ? "#ffffff" : ED.text1,
		}}
	>
		{children}
	</span>
);
