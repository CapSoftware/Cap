"use client";

import clsx from "clsx";
import { motion, useInView, useReducedMotion } from "motion/react";
import { type ReactNode, useId, useRef } from "react";
import { htMono } from "../../pages/HomeTwo/fonts";

/**
 * Four arrangements of the soft white light ribbons every figure sits on, so
 * neighbouring figures don't look stamped from the same mould.
 */
const RIBBONS = [
	{
		band: "M-80 520 C 220 330 420 640 700 420 S 1120 120 1300 220",
		edge: "M-80 506 C 220 316 420 626 700 406 S 1120 106 1300 206",
		shade: "M-60 120 C 200 230 380 40 640 140 S 1060 360 1300 300",
	},
	{
		band: "M-80 180 C 260 60 460 380 760 260 S 1140 420 1300 340",
		edge: "M-80 168 C 260 48 460 368 760 248 S 1140 408 1300 328",
		shade: "M-60 560 C 240 460 520 640 820 520 S 1180 420 1300 470",
	},
	{
		band: "M-80 420 C 180 520 400 200 640 300 S 1060 560 1300 420",
		edge: "M-80 407 C 180 507 400 187 640 287 S 1060 547 1300 407",
		shade: "M-60 80 C 300 180 520 0 800 120 S 1160 240 1300 160",
	},
	{
		band: "M-80 300 C 300 120 520 520 860 340 S 1160 160 1300 200",
		edge: "M-80 287 C 300 107 520 507 860 327 S 1160 147 1300 187",
		shade: "M-60 560 C 260 600 460 420 760 500 S 1120 640 1300 580",
	},
] as const;

export type RibbonKey = 0 | 1 | 2 | 3;

/** A soft grey panel with glossy white ribbons of light across it. */
export function Ribbons({ variant = 0 }: { variant?: RibbonKey }) {
	const id = useId().replace(/:/g, "");
	const ribbon = RIBBONS[variant];
	return (
		<svg
			aria-hidden="true"
			className="absolute inset-0 size-full"
			viewBox="0 0 1200 640"
			preserveAspectRatio="xMidYMid slice"
		>
			<defs>
				<linearGradient id={`${id}-base`} x1="0" y1="0" x2="0" y2="1">
					<stop offset="0" stopColor="#EEF0F3" />
					<stop offset="1" stopColor="#E1E4E9" />
				</linearGradient>
				<linearGradient id={`${id}-light`} x1="0" y1="0" x2="1" y2="0">
					<stop offset="0" stopColor="#FFFFFF" stopOpacity="0" />
					<stop offset="0.45" stopColor="#FFFFFF" stopOpacity="0.95" />
					<stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
				</linearGradient>
				<filter id={`${id}-soft`} x="-20%" y="-100%" width="140%" height="300%">
					<feGaussianBlur stdDeviation="26" />
				</filter>
			</defs>
			<rect width="1200" height="640" fill={`url(#${id}-base)`} />
			<path
				d={ribbon.shade}
				stroke="#C7CBD3"
				strokeWidth="90"
				fill="none"
				opacity="0.55"
				filter={`url(#${id}-soft)`}
			/>
			<path
				d={ribbon.band}
				stroke={`url(#${id}-light)`}
				strokeWidth="110"
				fill="none"
				filter={`url(#${id}-soft)`}
			/>
			<path
				d={ribbon.edge}
				stroke={`url(#${id}-light)`}
				strokeWidth="1.6"
				fill="none"
			/>
		</svg>
	);
}

/**
 * Every figure in the post is the same thing: a soft grey panel with light
 * ribbons, one width, one line of caption, and a short fade the first time
 * it comes into view. Nothing inside moves unless you touch it.
 *
 * It breaks out of the prose column with `94vw` rather than `100vw` so it
 * never adds a horizontal scrollbar, and avoids `p`, `a` and `li` inside,
 * because globals.css sizes those with `!important` inside `.prose`.
 */
export function Stage({
	ribbons = 0,
	caption,
	children,
	className,
}: {
	ribbons?: RibbonKey;
	caption?: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<FadeIn className="not-prose relative left-1/2 my-14 w-[min(94vw,68rem)] -translate-x-1/2 sm:my-20">
			<div className="relative overflow-hidden rounded-[20px] bg-[#E6E8EC] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.04)] sm:rounded-[24px]">
				<Ribbons variant={ribbons} />
				<div
					className={clsx(
						"relative px-3 py-8 sm:px-10 sm:py-14 lg:px-16",
						className,
					)}
				>
					{children}
				</div>
			</div>
			{caption && (
				<figcaption className="mx-auto mt-4 max-w-[40rem] px-2 text-center text-[14px] leading-relaxed text-gray-10">
					{caption}
				</figcaption>
			)}
		</FadeIn>
	);
}

/** A figure that fades in once, the first time it's on screen. */
export function FadeIn({
	className,
	children,
}: {
	className?: string;
	children: ReactNode;
}) {
	const ref = useRef<HTMLElement>(null);
	const seen = useInView(ref, { once: true, amount: 0.15 });
	const reduceMotion = useReducedMotion() ?? false;
	return (
		<motion.figure
			ref={ref}
			className={className}
			initial={false}
			animate={{ opacity: seen || reduceMotion ? 1 : 0 }}
			transition={{ duration: 0.6, ease: "easeOut" }}
		>
			{children}
		</motion.figure>
	);
}

/**
 * The charts sit straight on the page, like a table in a book: a hairline,
 * a few rows and the numbers. A bit wider than the text column so a bar has
 * room to mean something.
 */
export function Chart({
	title,
	subtitle,
	controls,
	caption,
	children,
}: {
	title: ReactNode;
	subtitle?: ReactNode;
	controls?: ReactNode;
	caption?: ReactNode;
	children: ReactNode;
}) {
	return (
		<FadeIn className="chart-figure not-prose relative left-1/2 my-14 w-[min(calc(100vw-2.5rem),48rem)] -translate-x-1/2 sm:my-16">
			<div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b border-gray-4 pb-4">
				<div className="min-w-0">
					<div className="text-[17px] font-medium leading-snug text-gray-12">
						{title}
					</div>
					{subtitle && (
						<div className="mt-0.5 text-[14px] leading-snug text-gray-10">
							{subtitle}
						</div>
					)}
				</div>
				{controls}
			</div>
			{children}
			{caption && (
				<figcaption className="mt-5 border-t border-gray-4 pt-4 text-[13px] leading-relaxed text-gray-10">
					{caption}
				</figcaption>
			)}
		</FadeIn>
	);
}

/** Plain text tabs. The active one gets a soft grey fill, nothing slides. */
export function Tabs<T extends string>({
	label,
	options,
	value,
	onChange,
}: {
	label: string;
	options: readonly { value: T; label: string }[];
	value: T;
	onChange: (value: T) => void;
}) {
	return (
		<fieldset className="-mr-2 m-0 flex min-w-0 gap-0.5 border-0 p-0">
			<legend className="sr-only">{label}</legend>
			{options.map((option) => {
				const active = option.value === value;
				return (
					<button
						key={option.value}
						type="button"
						aria-pressed={active}
						onClick={() => onChange(option.value)}
						className={clsx(
							"h-8 rounded-full px-3 text-[14px] transition-colors duration-150",
							active
								? "bg-gray-3 font-medium text-gray-12"
								: "text-gray-10 hover:text-gray-12",
						)}
					>
						{option.label}
					</button>
				);
			})}
		</fieldset>
	);
}

/**
 * One row of a chart: a name, a thin bar and its value. Only the new app is
 * blue, so the eye lands on it first. Widths ease when a tab changes.
 */
export function BarRow({
	name,
	detail,
	value,
	share,
	highlight,
}: {
	name: string;
	detail?: string;
	value: string;
	share: number;
	highlight?: boolean;
}) {
	return (
		<div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 py-3">
			<div className="min-w-0 truncate text-[15px] text-gray-12">
				{name}
				{detail && <span className="ml-2 text-gray-10">{detail}</span>}
			</div>
			<div
				className={clsx(
					"text-[15px] tabular-nums",
					highlight ? "font-medium text-gray-12" : "text-gray-11",
				)}
			>
				{value}
			</div>
			<div className="col-span-2 mt-2 h-1.5 rounded-full bg-gray-3">
				<div
					className={clsx(
						"h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none",
						highlight ? "bg-[#3B6FE8]" : "bg-gray-7",
					)}
					style={{ width: `${Math.max(1.5, share * 100)}%` }}
				/>
			</div>
		</div>
	);
}

/** A big number with a short line under it, for the result of a chart. */
export function Headline({ value, label }: { value: string; label: string }) {
	return (
		<div>
			<div className="text-[44px] font-semibold leading-none tracking-[-0.035em] tabular-nums text-gray-12 sm:text-[52px]">
				{value}
			</div>
			<div className="mt-2 text-[14px] text-gray-10">{label}</div>
		</div>
	);
}

export const mono = htMono.className;
