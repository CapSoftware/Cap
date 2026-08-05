"use client";

import clsx from "clsx";
import { useState } from "react";
import { DemoButton, DemoPanel } from "./DemoPanel";
import { DemoPlayhead, DemoStrip } from "./DemoStrip";
import { DEMO_DURATION, formatClock, QUIET_GAP } from "./scene";

const [GAP_START, GAP_END] = QUIET_GAP;
/** Generous: the point is to notice the hole, not to hit a frame. */
const TOLERANCE = 2;

/**
 * A small game, because "the waveform shows you where the talking is" is a
 * sentence people nod at and don't believe until they've tried to find a pause
 * without one.
 */
export function WaveformDemo() {
	const [waveform, setWaveform] = useState(false);
	const [guess, setGuess] = useState<number | null>(null);
	const [attempts, setAttempts] = useState(0);

	const hit =
		guess !== null &&
		guess >= GAP_START - TOLERANCE &&
		guess <= GAP_END + TOLERANCE;
	const reveal = hit || attempts >= 3;

	return (
		<DemoPanel
			title="The waveform"
			hint="Somewhere in this recording the talking stops for nine seconds. Click where you think it is, then turn the waveform on and try again."
			action={
				<DemoButton
					onClick={() => setWaveform((value) => !value)}
					variant={waveform ? "solid" : "ghost"}
				>
					<span
						className={clsx(
							"size-1.5 rounded-full",
							waveform ? "bg-emerald-400" : "bg-gray-8",
						)}
					/>
					Waveform {waveform ? "on" : "off"}
				</DemoButton>
			}
			caption="Cap draws this from the transcript rather than from decoded audio, so it is a map of speech, not of sound. Good for finding the part where someone answers your question; it will not show you the backing music."
		>
			<div className="relative overflow-hidden rounded-xl border border-gray-4">
				<DemoStrip
					time={guess ?? 0}
					waveform={waveform}
					onSeek={(t) => {
						setGuess(t);
						setAttempts((count) => count + 1);
					}}
					heightClass="h-16 sm:h-20"
					label="Guess where the pause is"
				>
					{reveal && (
						<div
							className="pointer-events-none absolute inset-y-0 z-20 border-x-2 border-emerald-500 bg-emerald-500/25"
							style={{
								left: `${(GAP_START / DEMO_DURATION) * 100}%`,
								width: `${((GAP_END - GAP_START) / DEMO_DURATION) * 100}%`,
							}}
						/>
					)}
					{guess !== null && <DemoPlayhead time={guess} />}
				</DemoStrip>
			</div>

			<div
				className={clsx(
					"mt-3 flex min-h-9 items-center gap-2 rounded-lg px-3 py-2 text-[13px]",
					guess === null && "bg-gray-2 text-gray-10",
					guess !== null && hit && "bg-emerald-500/10 text-emerald-700",
					guess !== null && !hit && "bg-gray-2 text-gray-11",
				)}
			>
				{guess === null ? (
					<span>Click anywhere on the strip.</span>
				) : hit ? (
					<span>
						Found it. Nobody says a word between{" "}
						<span className="font-medium">{formatClock(GAP_START)}</span> and{" "}
						<span className="font-medium">{formatClock(GAP_END)}</span>. They
						are switching apps.
					</span>
				) : (
					<span>
						Still talking at{" "}
						<span className="font-medium">{formatClock(guess)}</span>.
						{attempts >= 3
							? " The quiet stretch is marked above."
							: waveform
								? " Look for the flat part."
								: " Try turning the waveform on."}
					</span>
				)}
				{guess !== null && (
					<button
						type="button"
						onClick={() => {
							setGuess(null);
							setAttempts(0);
						}}
						className="ml-auto shrink-0 text-[13px] font-medium text-gray-11 underline-offset-2 hover:underline"
					>
						Reset
					</button>
				)}
			</div>
		</DemoPanel>
	);
}
