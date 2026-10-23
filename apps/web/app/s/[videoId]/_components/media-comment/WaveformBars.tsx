"use client";

import type { MouseEvent as ReactMouseEvent, RefObject } from "react";

/** Bars in a full-width voice note, and in a cramped one. */
export const WAVEFORM_BAR_COUNT = 64;
export const WAVEFORM_BAR_COUNT_COMPACT = 40;

/** Peaks stay inside this band so a bar is never invisible and never clipped. */
export const WAVEFORM_MIN_PEAK = 0.15;
export const WAVEFORM_MAX_PEAK = 0.9;

const clampPeak = (value: number) =>
	Math.min(WAVEFORM_MAX_PEAK, Math.max(WAVEFORM_MIN_PEAK, value));

/**
 * Deterministic stand-in waveform for notes recorded before peak extraction
 * existed (or whose extraction failed).
 *
 * Seeded entirely by the comment id, so a given note draws the same shape on
 * every render, in every tab, forever — a random fallback would shimmer on each
 * re-render. Two out-of-phase sines give it a spoken-sentence envelope, an
 * xorshift stream roughens it, and a centre-weighted taper keeps the ends
 * quieter the way a real recording tends to be.
 */
export function pseudoWaveform(
	seed: string,
	bars: number = WAVEFORM_BAR_COUNT,
): number[] {
	if (!Number.isFinite(bars) || bars <= 0) return [];
	const count = Math.floor(bars);

	// FNV-1a over the id: cheap, stable, and well spread for short strings.
	let hash = 0x811c9dc5;
	for (let index = 0; index < seed.length; index += 1) {
		hash ^= seed.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}

	const phase = ((hash % 1000) / 1000) * Math.PI * 2;
	let state = hash || 0x9e3779b9;
	const peaks: number[] = new Array(count);

	for (let index = 0; index < count; index += 1) {
		state ^= (state << 13) >>> 0;
		state >>>= 0;
		state ^= state >>> 17;
		state ^= (state << 5) >>> 0;
		state >>>= 0;
		const noise = state / 0xffffffff;

		const t = count === 1 ? 0.5 : index / (count - 1);
		const body = (Math.sin(phase + t * Math.PI * 2) + 1) / 2;
		const detail = (Math.sin(phase * 0.7 + t * Math.PI * 11) + 1) / 2;
		const taper = 0.68 + 0.32 * Math.sin(Math.PI * t);
		const mixed = (0.45 * body + 0.27 * detail + 0.28 * noise) * taper;

		peaks[index] = clampPeak(
			WAVEFORM_MIN_PEAK + mixed * (WAVEFORM_MAX_PEAK - WAVEFORM_MIN_PEAK),
		);
	}

	return peaks;
}

/**
 * Squash (or stretch) stored peaks onto the number of bars actually rendered,
 * taking the loudest sample per bucket so a resampled waveform keeps its
 * transients instead of averaging into mush.
 */
export function resampleWaveform(
	peaks: readonly number[],
	bars: number,
): number[] {
	if (!Number.isFinite(bars) || bars <= 0) return [];
	const count = Math.floor(bars);
	const out: number[] = new Array(count);

	for (let index = 0; index < count; index += 1) {
		const start = Math.floor((index * peaks.length) / count);
		const end = Math.max(
			start + 1,
			Math.floor(((index + 1) * peaks.length) / count),
		);
		let peak = 0;
		for (
			let source = start;
			source < end && source < peaks.length;
			source += 1
		) {
			const value = peaks[source];
			if (typeof value === "number" && Number.isFinite(value) && value > peak) {
				peak = value;
			}
		}
		out[index] = clampPeak(peak);
	}

	return out;
}

/** Stored peaks when we have them, a stable pseudo-waveform when we do not. */
export function resolveWaveform(
	seed: string,
	peaks: readonly number[] | null | undefined,
	bars: number = WAVEFORM_BAR_COUNT,
): number[] {
	if (peaks && peaks.length > 0) return resampleWaveform(peaks, bars);
	return pseudoWaveform(seed, bars);
}

/** Tallest a bar can draw, in px. Peaks are a fraction of this. */
const BAR_MAX_HEIGHT = 20;
const BAR_MIN_HEIGHT = 3;

interface WaveformBarsProps {
	peaks: number[];
	/**
	 * Progress wrapper: the player writes `--p` on this node inside its rAF
	 * loop, and the blue overlay's clip-path follows without a React render.
	 */
	progressRef?: RefObject<HTMLElement | null>;
	onSeek?: (fraction: number) => void;
	className?: string;
}

const barRow = (peaks: number[], color: string) =>
	peaks.map((peak, index) => (
		<span
			key={`${index}-${peak}`}
			className={`w-[2px] shrink-0 rounded-full ${color}`}
			style={{
				height: `${Math.max(BAR_MIN_HEIGHT, Math.round(peak * BAR_MAX_HEIGHT))}px`,
			}}
		/>
	));

/**
 * Two identical bar rows stacked in the same box. The lower one is the unplayed
 * track; the upper one is the played colour, revealed by clipping its wrapper
 * to `--p`. Painting progress as a clip means playback never touches React.
 */
export function WaveformBars({
	peaks,
	progressRef,
	onSeek,
	className,
}: WaveformBarsProps) {
	const seek = (event: ReactMouseEvent<HTMLElement>) => {
		if (!onSeek) return;
		const bounds = event.currentTarget.getBoundingClientRect();
		if (bounds.width <= 0) return;
		const fraction = (event.clientX - bounds.left) / bounds.width;
		onSeek(Math.min(1, Math.max(0, fraction)));
	};

	return (
		// A button (not a div) so the scrub target is a real control, but kept out
		// of the tab order: the play/pause button next to it is the keyboard path,
		// and scrubbing is a pointer-only refinement.
		<button
			type="button"
			tabIndex={-1}
			aria-label="Seek within voice note"
			ref={progressRef as RefObject<HTMLButtonElement | null> | undefined}
			onClick={seek}
			className={`relative flex h-5 min-w-0 shrink items-center gap-px ${
				onSeek ? "cursor-pointer" : "cursor-default"
			} ${className ?? ""}`}
		>
			{barRow(peaks, "bg-gray-7")}
			<span
				aria-hidden
				className="flex absolute inset-0 gap-px items-center"
				style={{ clipPath: "inset(0 calc(100% - var(--p, 0%)) 0 0)" }}
			>
				{barRow(peaks, "bg-blue-9")}
			</span>
		</button>
	);
}
