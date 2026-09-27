"use client";

import { XIcon } from "lucide-react";

// A looping picture of the browser's share popup: the audio switch at its
// bottom gets turned on, then Share is clicked. People miss that switch more
// than anything else in the flow.
export const SystemAudioGuide = ({ onClose }: { onClose?: () => void }) => (
	<div className="cap-rec rec-pop rec-rise fixed bottom-4 left-4 right-4 z-[520] p-4 sm:left-auto sm:right-5 sm:bottom-5 sm:w-[360px]">
		<div className="flex items-start justify-between gap-3">
			<div className="flex flex-col gap-0.5">
				<span className="text-[14px] font-medium text-[var(--rec-text-1)]">
					Record your computer's sound
				</span>
				<span className="text-[13px] leading-snug text-[var(--rec-text-2)]">
					In the popup, turn on Share system audio, then click Share.
				</span>
			</div>
			{onClose && (
				<button
					type="button"
					onClick={onClose}
					aria-label="Close"
					className="rec-btn is-ghost is-icon !h-7 !w-7 -mr-1 -mt-1"
				>
					<XIcon className="size-4" aria-hidden />
				</button>
			)}
		</div>
		<svg
			viewBox="0 0 320 150"
			className="mt-3 w-full overflow-visible rounded-[10px] bg-[var(--rec-card-2)]"
			aria-hidden="true"
		>
			<rect
				x="16"
				y="24"
				width="288"
				height="44"
				rx="10"
				fill="var(--rec-card)"
				stroke="var(--rec-line-strong)"
			/>
			<path
				d="M 32 41 L 36 41 L 41 37 L 41 55 L 36 51 L 32 51 Z M 45 41 Q 49 46 45 51 M 48 38 Q 55 46 48 54"
				fill="none"
				stroke="var(--rec-text-1)"
				strokeWidth="1.6"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<text
				x="64"
				y="50.5"
				fontSize="13"
				fill="var(--rec-text-1)"
				fontFamily="inherit"
			>
				Share system audio
			</text>
			<rect
				className="rec-guide-switch"
				x="258"
				y="37"
				width="30"
				height="18"
				rx="9"
			/>
			<circle className="rec-guide-knob" cx="267" cy="46" r="7" fill="#fff" />
			<circle
				className="rec-guide-ripple"
				cx="273"
				cy="46"
				r="12"
				fill="var(--rec-accent)"
			/>
			<rect
				x="150"
				y="88"
				width="70"
				height="32"
				rx="16"
				fill="none"
				stroke="var(--rec-line-strong)"
			/>
			<text
				x="185"
				y="108.5"
				fontSize="13"
				textAnchor="middle"
				fill="var(--rec-text-1)"
				fontFamily="inherit"
			>
				Cancel
			</text>
			<g className="rec-guide-share">
				<rect
					x="228"
					y="88"
					width="76"
					height="32"
					rx="16"
					fill="var(--rec-accent)"
				/>
				<text
					x="266"
					y="108.5"
					fontSize="13"
					textAnchor="middle"
					fill="#fff"
					fontFamily="inherit"
					fontWeight="500"
				>
					Share
				</text>
			</g>
			<circle
				className="rec-guide-ripple is-second"
				cx="266"
				cy="104"
				r="14"
				fill="var(--rec-accent)"
			/>
			<g className="rec-guide-cursor">
				<path
					d="M 0 0 L 0 17 L 4.5 12.8 L 7.6 19.6 L 10.4 18.4 L 7.4 11.7 L 13 11.4 Z"
					fill="var(--rec-text-1)"
					stroke="var(--rec-card)"
					strokeWidth="1.4"
					strokeLinejoin="round"
				/>
			</g>
		</svg>
		<p className="mt-2.5 text-[12px] leading-snug text-[var(--rec-text-3)]">
			Sharing a tab instead? The switch is called Also share tab audio.
		</p>
	</div>
);
