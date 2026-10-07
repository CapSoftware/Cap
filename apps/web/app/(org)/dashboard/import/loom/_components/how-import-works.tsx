"use client";

import { Dialog, DialogContent, DialogTitle } from "@cap/ui";
import clsx from "clsx";
import { type CSSProperties, useCallback, useEffect, useState } from "react";
import { Boil, delay, LoomMark, useReducedMotion } from "./doodles";
import "./loom-import.css";

const Chip = ({
	x,
	y,
	width,
	label,
	accent = false,
	at,
}: {
	x: number;
	y: number;
	width: number;
	label: string;
	accent?: boolean;
	at: number;
}) => (
	<g className="li-rise" style={delay(at)}>
		<rect
			x={x}
			y={y - 13}
			width={width}
			height={26}
			rx={13}
			fill={accent ? "var(--li-accent)" : "var(--li-paper-2)"}
			stroke={accent ? "none" : "var(--li-line-strong)"}
		/>
		<text
			x={x + width / 2}
			y={y + 4.5}
			textAnchor="middle"
			fontSize="12.5"
			fontFamily="inherit"
			fontWeight={accent ? 500 : 400}
			fill={accent ? "#fff" : "var(--li-ink)"}
		>
			{label}
		</text>
	</g>
);

const Sheet = ({ x, y, at = 0 }: { x: number; y: number; at?: number }) => (
	<g transform={`translate(${x} ${y})`}>
		<path
			className="li-ink li-draw"
			pathLength={1}
			style={delay(at)}
			d="M 0 0 L 36 0 L 50 14 L 50 64 L 0 64 Z M 36 0 L 36 14 L 50 14"
			fill="var(--li-paper)"
		/>
		<path
			className="li-ink is-thin is-soft li-draw"
			pathLength={1}
			style={delay(at + 0.3)}
			d="M 9 28 L 41 28 M 9 38 L 41 38 M 9 48 L 31 48"
		/>
		<path
			className="li-ink is-thin is-accent li-draw"
			pathLength={1}
			style={delay(at + 0.55)}
			d="M 9 28 L 19 28 M 9 38 L 19 38 M 9 48 L 19 48"
		/>
	</g>
);

const ExportScene = () => (
	<svg viewBox="0 0 480 220" className="size-full" aria-hidden="true">
		<rect
			x="40"
			y="16"
			width="300"
			height="188"
			rx="14"
			fill="var(--li-paper)"
			stroke="var(--li-line-strong)"
		/>
		<path d="M 40 44 L 340 44" stroke="var(--li-line)" />
		{[58, 72, 86].map((cx) => (
			<circle key={cx} cx={cx} cy="30" r="4.5" fill="var(--li-line-strong)" />
		))}
		<g transform="translate(298 22)">
			<LoomMark size={16} />
		</g>
		<path d="M 120 44 L 120 204" stroke="var(--li-line)" />
		{[66, 84, 102, 120].map((y) => (
			<rect
				key={y}
				x="56"
				y={y - 4}
				width={y === 102 ? 34 : 48}
				height="8"
				rx="4"
				fill="var(--li-line)"
			/>
		))}
		<Chip x={136} y={78} width={72} label="Settings" at={0.2} />
		<Chip x={216} y={78} width={86} label="Workspace" at={0.55} />
		<Chip x={136} y={116} width={52} label="Data" at={0.9} />
		<Chip x={196} y={116} width={68} label="Export" accent at={1.25} />
		<Boil>
			<path
				className="li-ink is-thin is-soft li-draw"
				pathLength={1}
				style={delay(1.7)}
				d="M 264 128 C 300 140 340 150 372 132 M 362 126 L 373 132 L 364 141"
			/>
			<Sheet x={384} y={92} at={2} />
		</Boil>
		<text
			x="409"
			y="180"
			textAnchor="middle"
			fontSize="12.5"
			fill="var(--li-ink-2)"
			fontFamily="inherit"
			className="li-fade"
			style={delay(2.6)}
		>
			your CSV
		</text>
	</svg>
);

const DropScene = () => (
	<svg viewBox="0 0 480 220" className="size-full" aria-hidden="true">
		<rect
			x="232"
			y="22"
			width="210"
			height="132"
			rx="16"
			fill="var(--li-accent-soft)"
			stroke="var(--li-accent)"
			strokeWidth="1.8"
			strokeDasharray="7 8"
			strokeLinecap="round"
		/>
		<g className="li-scene-slide">
			<Boil>
				<Sheet x={60} y={52} />
			</Boil>
		</g>
		<Chip x={232} y={186} width={78} label="Loom link" at={2.1} />
		<Chip x={318} y={186} width={60} label="Owner" at={2.35} />
		<Chip x={386} y={186} width={56} label="Space" at={2.6} />
		<Boil>
			<path
				className="li-ink is-thin is-soft li-draw"
				pathLength={1}
				style={delay(1.8)}
				d="M 150 186 C 176 186 196 186 220 186 M 212 180 L 221 186 L 212 192"
			/>
		</Boil>
		<text
			x="110"
			y="190"
			textAnchor="middle"
			fontSize="12.5"
			fill="var(--li-ink-2)"
			fontFamily="inherit"
			className="li-fade"
			style={delay(1.6)}
		>
			we find
		</text>
	</svg>
);

const CHECK_ROWS = [
	{ title: 148, ok: true },
	{ title: 112, ok: true },
	{ title: 168, ok: true },
	{ title: 126, ok: false },
	{ title: 140, ok: true },
] as const;

const CheckScene = () => (
	<svg viewBox="0 0 480 220" className="size-full" aria-hidden="true">
		{CHECK_ROWS.map((row, index) => {
			const y = 30 + index * 38;
			return (
				<g key={y} className="li-rise" style={delay(index * 0.12)}>
					<rect
						x="70"
						y={y - 13}
						width="44"
						height="26"
						rx="5"
						fill="var(--li-loom-soft)"
					/>
					<rect
						x="126"
						y={y - 9}
						width={row.title}
						height="7"
						rx="3.5"
						fill="var(--li-line-strong)"
					/>
					<rect
						x="126"
						y={y + 4}
						width="76"
						height="5"
						rx="2.5"
						fill="var(--li-line)"
					/>
				</g>
			);
		})}
		<Boil>
			{CHECK_ROWS.map((row, index) => {
				const y = 30 + index * 38;
				const at = 0.9 + index * 0.45;
				return row.ok ? (
					<path
						key={y}
						className="li-ink is-green li-draw"
						pathLength={1}
						style={delay(at)}
						d={`M 360 ${y} L 366 ${y + 6} L 378 ${y - 7}`}
					/>
				) : (
					<g key={y}>
						<path
							className="li-ink is-red li-draw"
							pathLength={1}
							style={delay(at)}
							d={`M 362 ${y - 1} L 362 ${y - 6} C 362 ${y - 14} 376 ${y - 14} 376 ${y - 6} L 376 ${y - 1} M 358 ${y - 1} L 380 ${y - 1} L 380 ${y + 11} L 358 ${y + 11} Z`}
						/>
					</g>
				);
			})}
		</Boil>
		<text
			x="392"
			y={30 + 3 * 38 + 4.5}
			fontSize="12.5"
			fill="var(--li-red)"
			fontFamily="inherit"
			className="li-fade"
			style={delay(2.4)}
		>
			private
		</text>
	</svg>
);

const COPY_PATH = "M 116 112 C 190 34 290 34 352 104";

const CopyScene = () => {
	const reducedMotion = useReducedMotion();
	return (
		<svg viewBox="0 0 480 220" className="size-full" aria-hidden="true">
			<circle cx="84" cy="112" r="34" fill="var(--li-loom-soft)" />
			<g transform="translate(72 100)">
				<LoomMark size={24} />
			</g>
			<Boil>
				<path className="li-ink is-soft li-march" d={COPY_PATH} />
			</Boil>
			{!reducedMotion &&
				[0, 0.8, 1.6].map((begin) => (
					<rect
						key={begin}
						x="-12"
						y="-8"
						width="24"
						height="16"
						rx="4"
						fill="var(--li-loom)"
						opacity="0"
					>
						<animateMotion
							dur="2.4s"
							begin={`${begin}s`}
							repeatCount="indefinite"
							path={COPY_PATH}
							keyPoints="0;1"
							keyTimes="0;1"
							calcMode="spline"
							keySplines="0.45 0 0.2 1"
						/>
						<animate
							attributeName="opacity"
							dur="2.4s"
							begin={`${begin}s`}
							repeatCount="indefinite"
							values="0;1;1;0"
							keyTimes="0;0.15;0.8;1"
						/>
					</rect>
				))}
			<rect
				x="352"
				y="66"
				width="108"
				height="92"
				rx="12"
				fill="var(--li-paper)"
				stroke="var(--li-line-strong)"
			/>
			{[0, 1, 2, 3, 4, 5].map((index) => (
				<rect
					key={index}
					className="li-pop"
					style={delay(0.5 + index * 0.45)}
					x={364 + (index % 3) * 30}
					y={80 + Math.floor(index / 3) * 34}
					width="24"
					height="26"
					rx="4"
					fill="var(--li-accent-soft)"
					stroke="color-mix(in srgb, var(--li-accent) 45%, transparent)"
				/>
			))}
			<text
				x="406"
				y="184"
				textAnchor="middle"
				fontSize="12.5"
				fill="var(--li-ink-2)"
				fontFamily="inherit"
			>
				your Cap library
			</text>
			<text
				x="234"
				y="150"
				textAnchor="middle"
				fontSize="12.5"
				fill="var(--li-ink-3)"
				fontFamily="inherit"
			>
				titles and dates come along
			</text>
		</svg>
	);
};

const WatchScene = () => (
	<svg viewBox="0 0 480 220" className="size-full" aria-hidden="true">
		<rect
			x="44"
			y="30"
			width="210"
			height="128"
			rx="12"
			fill="var(--li-paper)"
			stroke="var(--li-line-strong)"
		/>
		<circle
			cx="149"
			cy="94"
			r="24"
			fill="var(--li-accent)"
			className="li-pop"
		/>
		<path d="M 142 82 L 142 106 L 161 94 Z" fill="#fff" className="li-pop" />
		<g className="li-scene-cursor">
			<path
				d="M 0 0 L 0 17 L 4.5 12.8 L 7.6 19.6 L 10.4 18.4 L 7.4 11.7 L 13 11.4 Z"
				fill="var(--li-ink)"
				stroke="var(--li-paper)"
				strokeWidth="1.4"
				strokeLinejoin="round"
			/>
		</g>
		<rect
			x="282"
			y="30"
			width="160"
			height="128"
			rx="12"
			fill="var(--li-paper-2)"
			stroke="var(--li-line)"
		/>
		<text
			x="298"
			y="56"
			fontSize="12.5"
			fontWeight="500"
			fill="var(--li-ink)"
			fontFamily="inherit"
			className="li-fade"
			style={delay(1.4)}
		>
			Summary
		</text>
		<Boil>
			{[78, 94, 110, 126].map((y, index) => (
				<path
					key={y}
					className="li-ink is-thin is-soft li-draw"
					pathLength={1}
					style={delay(1.6 + index * 0.25)}
					d={`M 298 ${y} L ${index === 3 ? 380 : 424} ${y}`}
				/>
			))}
			<path
				className="li-spark"
				style={delay(2.7)}
				d="M 452 26 L 452 32 M 452 40 L 452 46 M 442 36 L 448 36 M 456 36 L 462 36"
			/>
		</Boil>
		<Chip x={282} y={186} width={84} label="Transcript" at={2.9} />
		<Chip x={374} y={186} width={74} label="Chapters" at={3.1} />
	</svg>
);

export const IMPORT_STEPS = [
	{
		title: "Get your list from Loom",
		body: "Loom admins can export every video from Settings, Workspace, Data, Export. No CSV? Paste your Loom links instead.",
		Scene: ExportScene,
	},
	{
		title: "Drop it into Cap",
		body: "We spot the column with Loom links on our own, plus owner emails and spaces if your list has them. Up to 2,000 videos per CSV.",
		Scene: DropScene,
	},
	{
		title: "We check every link first",
		body: "Titles, recording dates and lengths come straight from Loom. Private or deleted videos are flagged before anything is copied.",
		Scene: CheckScene,
	},
	{
		title: "Videos copy over in the background",
		body: "A few at a time, each into its owner's library with its original title and date. Close the tab whenever you like, it keeps going.",
		Scene: CopyScene,
	},
	{
		title: "AI starts when someone watches",
		body: "Transcripts, summaries and chapters are made the first time a video is opened, so nothing gets processed that nobody watches.",
		Scene: WatchScene,
	},
] as const;

const AUTO_ADVANCE_MS = 6500;

export const HowImportWorks = ({
	open,
	onOpenChange,
	initialStep = 0,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	initialStep?: number;
}) => {
	const [step, setStep] = useState(initialStep);
	const [auto, setAuto] = useState(true);
	const last = IMPORT_STEPS.length - 1;

	useEffect(() => {
		if (!open) return;
		setStep(initialStep);
		setAuto(true);
	}, [open, initialStep]);

	const go = useCallback(
		(next: number) => {
			setAuto(false);
			setStep(Math.max(0, Math.min(last, next)));
		},
		[last],
	);

	useEffect(() => {
		if (!open || !auto || step === last) return;
		const timer = window.setTimeout(() => setStep(step + 1), AUTO_ADVANCE_MS);
		return () => window.clearTimeout(timer);
	}, [open, auto, step, last]);

	const current = IMPORT_STEPS[step] ?? IMPORT_STEPS[0];
	const Scene = current.Scene;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="li-scope w-[calc(100%-20px)] max-w-[560px] overflow-hidden bg-gray-1"
				onKeyDown={(event) => {
					if (event.key === "ArrowRight") go(step + 1);
					else if (event.key === "ArrowLeft") go(step - 1);
				}}
			>
				<div className="relative h-[228px] border-b border-gray-3 bg-gray-2 sm:h-[248px]">
					<div key={step} className="li-fade absolute inset-0 px-4 py-3">
						<Scene />
					</div>
				</div>
				<div className="flex flex-col gap-1.5 px-5 pb-5 pt-4 sm:px-6">
					<span className="text-xs tabular-nums text-gray-10">
						{step + 1} of {IMPORT_STEPS.length}
					</span>
					<DialogTitle
						key={`title-${step}`}
						className="li-rise text-lg font-medium tracking-[-0.01em] text-gray-12"
					>
						{current.title}
					</DialogTitle>
					<p
						key={`body-${step}`}
						className="li-rise min-h-[44px] text-sm leading-relaxed text-gray-11"
						style={delay(0.05)}
					>
						{current.body}
					</p>
					<div className="mt-3 flex items-center justify-between gap-3">
						<div className="flex items-center gap-1.5">
							{IMPORT_STEPS.map((item, index) => (
								<button
									key={item.title}
									type="button"
									aria-label={`Step ${index + 1}: ${item.title}`}
									aria-current={index === step}
									onClick={() => go(index)}
									className="relative h-1.5 overflow-hidden rounded-full bg-gray-4 transition-[width] duration-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-9"
									style={{ width: index === step ? 28 : 6 }}
								>
									{index < step && (
										<span className="absolute inset-0 bg-gray-10" />
									)}
									{index === step && (
										<span
											key={`${step}-${auto}`}
											className={clsx(
												"absolute inset-y-0 left-0 bg-gray-12",
												auto && step !== last ? "li-how-fill" : "w-full",
											)}
											style={
												{
													"--li-how-ms": `${AUTO_ADVANCE_MS}ms`,
												} as CSSProperties
											}
										/>
									)}
								</button>
							))}
						</div>
						<div className="flex items-center gap-2">
							{step > 0 && (
								<button
									type="button"
									className="h-9 rounded-full px-4 text-sm text-gray-11 transition-colors hover:bg-gray-3 hover:text-gray-12"
									onClick={() => go(step - 1)}
								>
									Back
								</button>
							)}
							{step < last ? (
								<button
									type="button"
									className="h-9 rounded-full bg-gray-12 px-4 text-sm font-medium text-gray-1 transition-colors hover:bg-gray-11"
									onClick={() => go(step + 1)}
								>
									Next
								</button>
							) : (
								<button
									type="button"
									className="h-9 rounded-full bg-blue-9 px-4 text-sm font-medium text-white transition-[filter] hover:brightness-110"
									onClick={() => onOpenChange(false)}
								>
									Got it
								</button>
							)}
						</div>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
};
