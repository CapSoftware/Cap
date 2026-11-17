"use client";

import { classNames } from "@cap/utils/helpers";
import {
	type ComponentType,
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { Fit, LazyMount } from "../scenes/engine";
import { useInView, usePageVisible, useReducedMotion } from "../visibility";
import { Panel, TONES, type Tone } from "./layout";

export const CANVAS = { w: 1040, h: 600 } as const;

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export const seg = (t: number, from: number, to: number) =>
	ease(clamp01((t - from) / (to - from)));

export const ease = (x: number) =>
	x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;

export const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

export type SceneView = ComponentType<{
	t: number;
	playing: boolean;
	pick: number | null;
}>;

export type PickerOption = { key: string; label: string; icon: ReactNode };

export type Scene = {
	key: string;
	label: string;
	icon: ReactNode;
	lead: string;
	body: string;
	duration: number;
	pose: number;
	View: SceneView;
	picker?: {
		options: PickerOption[];
		at: (t: number) => number;
		swatches?: boolean;
	};
};

const useClock = ({
	playing,
	duration,
	resetKey,
	onEnd,
}: {
	playing: boolean;
	duration: number;
	resetKey: string;
	onEnd: () => void;
}) => {
	const [t, setT] = useState(0);
	const tRef = useRef(0);
	const endRef = useRef(onEnd);
	endRef.current = onEnd;
	const resetRef = useRef(resetKey);

	useEffect(() => {
		if (resetRef.current !== resetKey) {
			resetRef.current = resetKey;
			tRef.current = 0;
			setT(0);
		}
		if (!playing) return;
		let raf = 0;
		let last = performance.now();
		const frame = (now: number) => {
			const dt = Math.min(48, now - last);
			last = now;
			const next = tRef.current + dt;
			if (next >= duration) {
				tRef.current = duration;
				setT(duration);
				endRef.current();
				return;
			}
			tRef.current = next;
			setT(next);
			raf = requestAnimationFrame(frame);
		};
		raf = requestAnimationFrame(frame);
		return () => cancelAnimationFrame(raf);
	}, [playing, duration, resetKey]);

	return t;
};

const Tabs = ({
	scenes,
	active,
	progress,
	tone,
	onPick,
	className,
}: {
	scenes: Scene[];
	active: number;
	progress: number;
	tone: Tone;
	onPick: (index: number) => void;
	className?: string;
}) => {
	const refs = useRef<(HTMLButtonElement | null)[]>([]);
	const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);

	useLayoutEffect(() => {
		const measure = () => {
			const el = refs.current[active];
			if (el) setThumb({ x: el.offsetLeft, w: el.offsetWidth });
		};
		measure();
		const ro = new ResizeObserver(measure);
		const parent = refs.current[active]?.parentElement;
		if (parent) ro.observe(parent);
		return () => ro.disconnect();
	}, [active]);

	return (
		<div
			className={classNames(
				"relative inline-flex max-w-full gap-0.5 overflow-x-auto rounded-full bg-white p-1.5 shadow-[0_0_0_1px_rgba(17,17,17,0.07),0_1px_2px_rgba(17,17,17,0.05),0_12px_28px_-14px_rgba(17,24,39,0.3)] [scrollbar-width:none]",
				className,
			)}
		>
			{thumb ? (
				<span
					aria-hidden="true"
					className="absolute bottom-1.5 top-1.5 overflow-hidden rounded-full transition-[transform,width] duration-500 [transition-timing-function:cubic-bezier(0.34,1.4,0.5,1)]"
					style={{
						width: thumb.w,
						transform: `translateX(${thumb.x - 6}px)`,
						left: 6,
						background: `color-mix(in srgb, ${tone.accent} 12%, white)`,
						boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${tone.accent} 22%, transparent)`,
					}}
				>
					<span
						className="absolute inset-y-0 left-0"
						style={{
							width: `${progress * 100}%`,
							background: `color-mix(in srgb, ${tone.accent} 12%, transparent)`,
						}}
					/>
				</span>
			) : null}
			{scenes.map((scene, i) => {
				const on = i === active;
				return (
					<button
						key={scene.key}
						ref={(el) => {
							refs.current[i] = el;
						}}
						type="button"
						aria-pressed={on}
						onClick={() => onPick(i)}
						className={classNames(
							"relative z-10 flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-full px-3.5 text-[14px] tracking-[-0.01em] transition-colors duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111]",
							on
								? "font-medium"
								: "text-[rgba(17,17,17,0.64)] hover:text-[#111111]",
						)}
						style={on ? { color: tone.ink } : undefined}
					>
						<span
							aria-hidden="true"
							className="grid size-4 place-items-center transition-transform duration-300 [&>svg]:size-4"
							style={{ transform: on ? "scale(1.12)" : "none" }}
						>
							{scene.icon}
						</span>
						{scene.label}
					</button>
				);
			})}
		</div>
	);
};

const Picker = ({
	options,
	active,
	tone,
	swatches,
	onPick,
	vertical,
}: {
	options: PickerOption[];
	active: number;
	tone: Tone;
	swatches?: boolean;
	onPick: (index: number) => void;
	vertical?: boolean;
}) => (
	<div
		className={classNames(
			"flex gap-1 rounded-[18px] bg-white p-1.5 shadow-[0_0_0_1px_rgba(17,17,17,0.07),0_12px_28px_-14px_rgba(17,24,39,0.3)]",
			vertical ? "flex-col" : "flex-row",
		)}
	>
		{options.map((option, i) => {
			const on = i === active;
			return (
				<button
					key={option.key}
					type="button"
					aria-pressed={on}
					aria-label={option.label}
					title={option.label}
					onClick={() => onPick(i)}
					className={classNames(
						"group relative grid size-10 cursor-pointer place-items-center rounded-[12px] transition-[background-color,box-shadow,color] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111]",
						on
							? ""
							: "text-[rgba(17,17,17,0.45)] hover:bg-[#F3F5F8] hover:text-[#111111]",
					)}
					style={
						on && !swatches
							? {
									background: `color-mix(in srgb, ${tone.accent} 12%, white)`,
									color: tone.ink,
									boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${tone.accent} 25%, transparent)`,
								}
							: undefined
					}
				>
					{swatches ? (
						<span
							className="block size-7 rounded-full transition-shadow duration-200"
							style={{
								boxShadow: on
									? `0 0 0 2px #FFFFFF, 0 0 0 4px ${tone.accent}`
									: "inset 0 0 0 1px rgba(17,17,17,0.1)",
							}}
						>
							{option.icon}
						</span>
					) : (
						option.icon
					)}
					{vertical ? (
						<span className="pointer-events-none absolute right-full mr-2 whitespace-nowrap rounded-md bg-[#111111] px-2 py-1 text-[12px] text-white opacity-0 transition-opacity duration-150 group-hover:opacity-100">
							{option.label}
						</span>
					) : null}
				</button>
			);
		})}
	</div>
);

export const Showcase = ({
	scenes,
	tone = TONES.instant,
	canvas = CANVAS,
	className,
	caption = true,
}: {
	scenes: Scene[];
	tone?: Tone;
	canvas?: { w: number; h: number };
	className?: string;
	caption?: boolean;
}) => {
	const ref = useRef<HTMLDivElement | null>(null);
	const inView = useInView(ref, "-15% 0px -15% 0px");
	const pageVisible = usePageVisible();
	const reduced = useReducedMotion();
	const [active, setActive] = useState(0);
	const [round, setRound] = useState(0);
	const [picked, setPicked] = useState<number | null>(null);
	const scene = (scenes[active] ?? scenes[0]) as Scene;
	const playing = inView && pageVisible && picked === null && !reduced;

	const t = useClock({
		playing,
		duration: scene.duration,
		resetKey: `${scene.key}:${round}`,
		onEnd: () => {
			setActive((i) => (i + 1) % scenes.length);
			setRound((r) => r + 1);
			setPicked(null);
		},
	});

	const shown = reduced ? scene.pose : t;
	const pickTab = (i: number) => {
		setActive(i);
		setRound((r) => r + 1);
		setPicked(null);
	};
	const pickOption = (i: number) => setPicked(i);
	useEffect(() => {
		if (picked === null) return;
		const resume = setTimeout(() => setPicked(null), 8000);
		return () => clearTimeout(resume);
	}, [picked]);
	const picker = scene.picker;
	const pickerActive = picker ? (picked ?? picker.at(shown)) : 0;
	const progress = reduced ? 0 : shown / scene.duration;

	return (
		<div ref={ref} className={className}>
			<Panel tone={tone}>
				<LazyMount w={canvas.w} h={canvas.h} grow>
					<Fit w={canvas.w} h={canvas.h} grow>
						<scene.View
							key={`${scene.key}:${round}`}
							t={shown}
							playing={playing}
							pick={picked}
						/>
					</Fit>
				</LazyMount>
				{picker ? (
					<div
						key={scene.key}
						className="ht-fade-in absolute hidden -translate-x-1/2 -translate-y-1/2 sm:block"
						style={{ left: "92.9%", top: "44.6%" }}
					>
						<Picker
							options={picker.options}
							active={pickerActive}
							tone={tone}
							swatches={picker.swatches}
							onPick={pickOption}
							vertical
						/>
					</div>
				) : null}
				<div className="pointer-events-none absolute inset-x-0 bottom-4 hidden justify-center sm:flex lg:bottom-6">
					<Tabs
						scenes={scenes}
						active={active}
						progress={progress}
						tone={tone}
						onPick={pickTab}
						className="pointer-events-auto"
					/>
				</div>
			</Panel>
			{picker ? (
				<div className="mt-4 flex justify-center sm:hidden">
					<Picker
						options={picker.options}
						active={pickerActive}
						tone={tone}
						swatches={picker.swatches}
						onPick={pickOption}
					/>
				</div>
			) : null}
			<div className="mt-4 flex justify-center sm:hidden">
				<Tabs
					scenes={scenes}
					active={active}
					progress={progress}
					tone={tone}
					onPick={pickTab}
				/>
			</div>
			{caption ? (
				<p
					key={scene.key}
					aria-hidden="true"
					className="ht-fade-in mx-auto mt-7 max-w-[560px] text-balance text-center text-[15px] leading-[1.55] text-[rgba(17,17,17,0.64)]"
				>
					<span className="font-medium text-[#111111]">{scene.lead}</span>{" "}
					{scene.body}
				</p>
			) : null}
		</div>
	);
};

const useNarrow = () => {
	const [narrow, setNarrow] = useState(false);
	useEffect(() => {
		const query = window.matchMedia("(max-width: 639px)");
		const sync = () => setNarrow(query.matches);
		sync();
		query.addEventListener("change", sync);
		return () => query.removeEventListener("change", sync);
	}, []);
	return narrow;
};

const Cropped = ({
	canvas,
	crop,
	children,
}: {
	canvas: { w: number; h: number };
	crop?: { x: number; w: number };
	children: ReactNode;
}) => {
	const narrow = useNarrow();
	if (!narrow || !crop) return <>{children}</>;
	return (
		<div style={{ aspectRatio: `${crop.w} / ${canvas.h}`, overflow: "hidden" }}>
			<div
				style={{
					width: `${(canvas.w / crop.w) * 100}%`,
					marginLeft: `${(-crop.x / crop.w) * 100}%`,
				}}
			>
				{children}
			</div>
		</div>
	);
};

export const Loop = ({
	View,
	duration,
	pose,
	canvas,
	crop,
	tone,
	className,
}: {
	tone?: Tone;
	View: SceneView;
	duration: number;
	pose: number;
	canvas: { w: number; h: number };
	crop?: { x: number; w: number };
	className?: string;
}) => {
	const ref = useRef<HTMLDivElement | null>(null);
	const inView = useInView(ref, "-15% 0px -15% 0px");
	const pageVisible = usePageVisible();
	const reduced = useReducedMotion();
	const [round, setRound] = useState(0);
	const playing = inView && pageVisible && !reduced;
	const t = useClock({
		playing,
		duration,
		resetKey: String(round),
		onEnd: () => setRound((r) => r + 1),
	});
	return (
		<div ref={ref} className={className}>
			<Panel tone={tone}>
				<Cropped canvas={canvas} crop={crop}>
					<LazyMount w={canvas.w} h={canvas.h} grow>
						<Fit w={canvas.w} h={canvas.h} grow>
							<View
								key={round}
								t={reduced ? pose : t}
								playing={playing}
								pick={null}
							/>
						</Fit>
					</LazyMount>
				</Cropped>
			</Panel>
		</div>
	);
};

export {
	Badge,
	Details,
	Em,
	Section,
	SectionHead,
	TONES,
	type Tone,
	toneVars,
} from "./layout";
