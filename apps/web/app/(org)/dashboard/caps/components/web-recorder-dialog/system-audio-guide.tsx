"use client";

import { XIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

// Chrome dims the page behind its share popup, so this has to be seen before
// the popup opens: a looping picture of the audio switch at the popup's
// bottom being turned on, then Share being clicked.
export const SystemAudioGuide = ({
	onContinue,
	onClose,
}: {
	onContinue?: (dontShowAgain: boolean) => void;
	onClose: () => void;
}) => {
	const [dontShowAgain, setDontShowAgain] = useState(false);
	const checkboxId = useId();

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			onClose();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [onClose]);

	return (
		<div
			className="rec-fade absolute inset-0 z-30 flex items-center justify-center bg-[var(--rec-scrim)] p-4 backdrop-blur-md"
			role="dialog"
			aria-modal="true"
			aria-label="Record your computer's sound"
		>
			<div className="rec-pop rec-rise flex w-[min(440px,100%)] flex-col overflow-hidden">
				<div className="relative bg-[var(--rec-card-2)] px-6 pb-4 pt-6">
					<svg
						viewBox="0 0 320 150"
						className="w-full overflow-visible"
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
						<circle
							className="rec-guide-knob"
							cx="267"
							cy="46"
							r="7"
							fill="#fff"
						/>
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
					<button
						type="button"
						onClick={onClose}
						aria-label="Close"
						className="rec-btn is-ghost is-icon absolute right-2.5 top-2.5 !h-7 !w-7"
					>
						<XIcon className="size-4" aria-hidden />
					</button>
				</div>
				<div className="flex flex-col gap-1.5 px-6 pb-5 pt-4">
					<h2 className="text-[18px] font-medium tracking-[-0.01em]">
						Turn on sound in the next step
					</h2>
					<p className="text-[14px] leading-relaxed text-[var(--rec-text-2)]">
						Your browser asks what to share next. At the bottom of that popup,
						switch on Share system audio, then click Share. For a single tab
						it's called Also share tab audio.
					</p>
					<div className="mt-3 flex items-center justify-between gap-3">
						{onContinue ? (
							<label
								htmlFor={checkboxId}
								className="flex cursor-pointer items-center gap-2 text-[13px] text-[var(--rec-text-2)]"
							>
								<input
									id={checkboxId}
									type="checkbox"
									checked={dontShowAgain}
									onChange={(event) => setDontShowAgain(event.target.checked)}
									className="size-3.5 accent-[var(--rec-accent)]"
								/>
								Don't show this again
							</label>
						) : (
							<span />
						)}
						<button
							type="button"
							className="rec-btn is-accent"
							onClick={() =>
								onContinue ? onContinue(dontShowAgain) : onClose()
							}
						>
							{onContinue ? "Choose what to share" : "Got it"}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
};
