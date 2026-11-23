"use client";

import clsx from "clsx";
import { XIcon } from "lucide-react";
import {
	type CSSProperties,
	useCallback,
	useEffect,
	useId,
	useState,
} from "react";

const TRACKS = [
	{
		color: "var(--track-screen)",
		glyph: "M -7 -5 L 7 -5 L 7 4 L -7 4 Z M -3 7.5 L 3 7.5",
	},
	{
		color: "var(--track-camera)",
		glyph:
			"M -7 -3.5 L -3.5 -3.5 L -2 -6 L 2 -6 L 3.5 -3.5 L 7 -3.5 L 7 6 L -7 6 Z M 0 -0.8 m -2.6 0 a 2.6 2.6 0 1 0 5.2 0 a 2.6 2.6 0 1 0 -5.2 0",
	},
	{
		color: "var(--track-mic)",
		glyph:
			"M -2.5 -7 L 2.5 -7 L 2.5 1 Q 2.5 3.5 0 3.5 Q -2.5 3.5 -2.5 1 Z M -5.5 0 Q -5.5 6 0 6 Q 5.5 6 5.5 0 M 0 6 L 0 8.5",
	},
] as const;

const Glyph = ({ x, y, index }: { x: number; y: number; index: number }) => {
	const track = TRACKS[index];
	if (!track) return null;
	return (
		<g transform={`translate(${x} ${y})`}>
			<rect
				x="-15"
				y="-15"
				width="30"
				height="30"
				rx="8"
				fill={`color-mix(in srgb, ${track.color} 18%, transparent)`}
			/>
			<path
				d={track.glyph}
				fill="none"
				stroke={track.color}
				strokeWidth="1.7"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</g>
	);
};

const SourcesScene = () => (
	<svg viewBox="0 0 480 220" className="size-full" aria-hidden="true">
		{[0, 1, 2].map((index) => {
			const y = 46 + index * 50;
			return (
				<g
					key={index}
					className="rec-rise"
					style={{ "--d": `${index * 0.12}s` } as CSSProperties}
				>
					<rect
						x="110"
						y={y - 20}
						width="260"
						height="40"
						rx="10"
						fill="var(--rec-card)"
						stroke="var(--rec-line)"
					/>
					<Glyph x={136} y={y} index={index} />
					<text
						x="162"
						y={y + 4.5}
						fontSize="14"
						fill="var(--rec-text-1)"
						fontFamily="inherit"
					>
						{["Screen", "Camera", "Microphone"][index]}
					</text>
					<rect
						x="324"
						y={y - 9}
						width="30"
						height="18"
						rx="9"
						className="rec-scene-switch"
						style={{ "--d": `${0.5 + index * 0.35}s` } as CSSProperties}
					/>
					<circle
						cx="333"
						cy={y}
						r="7"
						fill="#fff"
						className="rec-scene-knob"
						style={{ "--d": `${0.5 + index * 0.35}s` } as CSSProperties}
					/>
				</g>
			);
		})}
	</svg>
);

const TracksScene = () => (
	<svg viewBox="0 0 480 220" className="size-full" aria-hidden="true">
		<path
			d="M 96 24 L 440 24"
			stroke="var(--rec-line-strong)"
			strokeWidth="1"
			strokeDasharray="1 11"
		/>
		{[0, 1, 2].map((index) => {
			const y = 60 + index * 50;
			const track = TRACKS[index];
			if (!track) return null;
			return (
				<g key={index}>
					<Glyph x={62} y={y} index={index} />
					<rect
						x="96"
						y={y - 17}
						width="344"
						height="34"
						rx="8"
						fill="var(--rec-ctl)"
					/>
					<g className="rec-scene-lane">
						<rect
							x="96"
							y={y - 17}
							width="344"
							height="34"
							rx="8"
							fill={`color-mix(in srgb, ${track.color} 20%, transparent)`}
							stroke={`color-mix(in srgb, ${track.color} 45%, transparent)`}
						/>
						<rect x="96" y={y - 17} width="3" height="34" fill={track.color} />
						{index === 2 &&
							Array.from({ length: 56 }, (_, bar) => {
								const height =
									4 +
									Math.abs(Math.sin(bar * 1.7) * 9 + Math.sin(bar * 0.6) * 6);
								return (
									<rect
										// biome-ignore lint/suspicious/noArrayIndexKey: static bars
										key={bar}
										x={106 + bar * 6}
										y={y - height / 2}
										width="2.4"
										height={height}
										rx="1.2"
										fill={track.color}
										opacity="0.7"
									/>
								);
							})}
					</g>
				</g>
			);
		})}
		<g
			className="rec-scene-playhead"
			style={{ "--span": "344px" } as CSSProperties}
		>
			<path d="M 96 30 L 96 196" stroke="var(--rec-red)" strokeWidth="2" />
			<circle cx="96" cy="28" r="5" fill="var(--rec-red)" />
		</g>
	</svg>
);

const UploadScene = () => (
	<svg viewBox="0 0 480 220" className="size-full" aria-hidden="true">
		<g className="rec-boil">
			<path
				d="M 150 110 C 220 40 290 40 348 104"
				className="rec-ink rec-march"
				style={{ stroke: "var(--rec-text-3)", strokeWidth: 2 }}
			/>
		</g>
		<rect
			x="40"
			y="84"
			width="110"
			height="52"
			rx="10"
			fill="color-mix(in srgb, var(--track-screen) 20%, transparent)"
			stroke="color-mix(in srgb, var(--track-screen) 45%, transparent)"
		/>
		<rect x="40" y="84" width="3" height="52" fill="var(--track-screen)" />
		<circle
			cx="62"
			cy="110"
			r="5"
			fill="var(--rec-red)"
			className="rec-pulse"
		/>
		<text
			x="76"
			y="115"
			fontSize="14"
			fill="var(--rec-text-1)"
			fontFamily="inherit"
		>
			0:42
		</text>
		{[0, 0.8, 1.6].map((begin) => (
			<rect
				key={begin}
				x="-9"
				y="-12"
				width="18"
				height="24"
				rx="4"
				fill="var(--track-screen)"
				opacity="0"
			>
				<animateMotion
					dur="2.4s"
					begin={`${begin}s`}
					repeatCount="indefinite"
					path="M 150 110 C 220 40 290 40 348 104"
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
		<g className="rec-scene-link">
			<circle cx="380" cy="110" r="32" fill="var(--rec-accent)" />
			<path
				d="M 374 116 L 386 104 M 371 110 l -3 3 a 5 5 0 0 0 7 7 l 3 -3 M 389 110 l 3 -3 a 5 5 0 0 0 -7 -7 l -3 3"
				fill="none"
				stroke="#fff"
				strokeWidth="2.4"
				strokeLinecap="round"
			/>
		</g>
		<text
			x="380"
			y="170"
			fontSize="13"
			textAnchor="middle"
			fill="var(--rec-text-2)"
			fontFamily="inherit"
		>
			Your link
		</text>
	</svg>
);

const LAYOUTS = ["Camera in the corner", "Side by side", "Just you"];

const LayoutScene = () => (
	<div className="flex size-full flex-col items-center justify-center gap-3">
		<svg viewBox="0 0 480 180" className="h-[78%] w-full" aria-hidden="true">
			<rect
				x="110"
				y="14"
				width="260"
				height="152"
				rx="12"
				fill="var(--rec-card)"
				stroke="var(--rec-line-strong)"
			/>
			<rect
				className="rec-layout-screen"
				x="122"
				y="26"
				width="236"
				height="128"
				rx="7"
				fill="color-mix(in srgb, var(--track-screen) 22%, var(--rec-card))"
				stroke="color-mix(in srgb, var(--track-screen) 45%, transparent)"
			/>
			<rect
				className="rec-layout-cam"
				x="310"
				y="108"
				width="38"
				height="38"
				rx="19"
				fill="color-mix(in srgb, var(--track-camera) 55%, var(--rec-card))"
			/>
		</svg>
		<div className="flex items-center gap-1.5 text-[12px]">
			{LAYOUTS.map((layout, index) => (
				<span
					key={layout}
					className="rec-layout-label rounded-full px-2.5 py-1"
					style={{ "--i": index } as CSSProperties}
				>
					{layout}
				</span>
			))}
		</div>
		<style>{`
			.rec-layout-screen { animation: rec-layout-screen 7.2s cubic-bezier(.65,0,.35,1) infinite; }
			.rec-layout-cam { animation: rec-layout-cam 7.2s cubic-bezier(.65,0,.35,1) infinite; }
			@keyframes rec-layout-screen {
				0%, 24% { width: 236px; }
				33%, 57% { width: 150px; }
				66%, 90% { width: 150px; }
				100% { width: 236px; }
			}
			@keyframes rec-layout-cam {
				0%, 24% { x: 310px; y: 108px; width: 38px; height: 38px; rx: 19px; }
				33%, 57% { x: 280px; y: 26px; width: 78px; height: 128px; rx: 7px; }
				66%, 90% { x: 122px; y: 26px; width: 236px; height: 128px; rx: 7px; }
				100% { x: 310px; y: 108px; width: 38px; height: 38px; rx: 19px; }
			}
			.rec-layout-label {
				color: var(--rec-text-3);
				animation: rec-layout-label 7.2s step-end infinite;
				animation-delay: calc(var(--i) * 2.4s - 0.35s);
			}
			@keyframes rec-layout-label {
				0% { color: var(--rec-text-1); background: var(--rec-ctl-hover); }
				33.333% { color: var(--rec-text-3); background: transparent; }
			}
			@media (prefers-reduced-motion: reduce) {
				.rec-layout-screen, .rec-layout-cam, .rec-layout-label { animation: none; }
			}
		`}</style>
	</div>
);

const STEPS = [
	{
		title: "Pick what you want to record",
		body: "Select a screen, choose your camera or No camera, and check your mic. Any mix works.",
		Scene: SourcesScene,
	},
	{
		title: "Each one records on its own track",
		body: "Nothing gets flattened together. Your screen, camera and audio stay separate, exactly as they'll appear in the editor.",
		Scene: TracksScene,
	},
	{
		title: "Your link is live while you record",
		body: "Your video uploads in parts as you go, so there's no export to wait for when you stop.",
		Scene: UploadScene,
	},
	{
		title: "Stop, then make it look how you want",
		body: "Your link opens in your default look. In the editor, pick a layout, trim and save, and your link updates.",
		Scene: LayoutScene,
	},
] as const;

const AUTO_ADVANCE_MS = 6000;

export const HowRecordingWorks = ({ onClose }: { onClose: () => void }) => {
	const titleId = useId();
	const [step, setStep] = useState(0);
	const [auto, setAuto] = useState(true);
	const last = STEPS.length - 1;

	const go = useCallback(
		(next: number) => {
			setAuto(false);
			setStep(Math.max(0, Math.min(last, next)));
		},
		[last],
	);

	useEffect(() => {
		if (!auto || step === last) return;
		const timer = window.setTimeout(() => setStep(step + 1), AUTO_ADVANCE_MS);
		return () => window.clearTimeout(timer);
	}, [auto, step, last]);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "ArrowRight") go(step + 1);
			else if (event.key === "ArrowLeft") go(step - 1);
			else if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				onClose();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [go, onClose, step]);

	const current = STEPS[step] ?? STEPS[0];
	const Scene = current.Scene;

	return (
		<div
			className="rec-fade absolute inset-0 z-30 flex items-center justify-center bg-[var(--rec-scrim)] p-4"
			role="dialog"
			aria-modal="true"
			aria-labelledby={titleId}
		>
			<div className="rec-pop rec-rise flex w-[min(560px,100%)] flex-col overflow-hidden">
				<div className="relative h-[228px] bg-[var(--rec-card-2)] sm:h-[248px]">
					<div key={step} className="rec-fade absolute inset-0 px-4 py-3">
						<Scene />
					</div>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close"
						className="rec-btn is-ghost is-icon absolute right-2.5 top-2.5 !h-7 !w-7"
					>
						<XIcon className="size-4" aria-hidden />
					</button>
				</div>
				<div className="flex flex-col gap-1.5 px-5 pb-5 pt-4 sm:px-6">
					<span className="text-[12px] tabular-nums text-[var(--rec-text-3)]">
						{step + 1} of {STEPS.length}
					</span>
					<h2
						id={titleId}
						key={`title-${step}`}
						className="rec-rise text-[18px] font-medium tracking-[-0.01em] text-[var(--rec-text-1)]"
					>
						{current.title}
					</h2>
					<p
						key={`body-${step}`}
						className="rec-rise min-h-[44px] text-[14px] leading-relaxed text-[var(--rec-text-2)]"
						style={{ "--d": "0.05s" } as CSSProperties}
					>
						{current.body}
					</p>
					<div className="mt-3 flex items-center justify-between gap-3">
						<div className="flex items-center gap-1.5">
							{STEPS.map((item, index) => (
								<button
									key={item.title}
									type="button"
									aria-label={`Step ${index + 1}`}
									aria-current={index === step}
									onClick={() => go(index)}
									className="rec-focus relative h-1.5 overflow-hidden rounded-full bg-[var(--rec-ctl-active)] transition-[width] duration-300"
									style={{ width: index === step ? 28 : 6 }}
								>
									{index < step && (
										<span className="absolute inset-0 bg-[var(--rec-text-2)]" />
									)}
									{index === step && (
										<span
											key={`${step}-${auto}`}
											className={clsx(
												"absolute inset-y-0 left-0 bg-[var(--rec-text-1)]",
												auto && step !== last ? "rec-how-fill" : "w-full",
											)}
										/>
									)}
								</button>
							))}
						</div>
						<div className="flex items-center gap-2">
							{step > 0 && (
								<button
									type="button"
									className="rec-btn is-ghost"
									onClick={() => go(step - 1)}
								>
									Back
								</button>
							)}
							{step < last ? (
								<button
									type="button"
									className="rec-btn"
									onClick={() => go(step + 1)}
								>
									Next
								</button>
							) : (
								<button
									type="button"
									className="rec-btn is-accent"
									onClick={onClose}
								>
									Got it
								</button>
							)}
						</div>
					</div>
				</div>
			</div>
			<style>{`
				.rec-how-fill { animation: rec-how-fill ${AUTO_ADVANCE_MS}ms linear both; }
				@keyframes rec-how-fill { from { width: 0; } to { width: 100%; } }
			`}</style>
		</div>
	);
};
