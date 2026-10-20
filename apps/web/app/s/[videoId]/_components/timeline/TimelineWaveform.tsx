"use client";

import { memo, useEffect, useRef, useState } from "react";

interface TimelineWaveformProps {
	envelope: Float32Array | null;
	start: number;
	end: number;
	duration: number;
}

/** Peak height as a share of half the strip. */
const AMPLITUDE = 0.86;

// Light enough that a wall-to-wall envelope (any video with continuous speech)
// reads as texture over the film rather than a solid block covering it.
const FILL = "rgba(18,22,31,0.4)";

/**
 * The readable layer over the washed-out film: a symmetric envelope of the audio,
 * drawn once per (envelope, window, size) and never again. Playback does not
 * touch it — progress is the wash and the underline above.
 */
export const TimelineWaveform = memo(function TimelineWaveform({
	envelope,
	start,
	end,
	duration,
}: TimelineWaveformProps) {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const [size, setSize] = useState({ width: 0, height: 0 });

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas || typeof ResizeObserver === "undefined") return;

		const measure = () => {
			const width = Math.round(canvas.clientWidth);
			const height = Math.round(canvas.clientHeight);
			setSize((prev) =>
				prev.width === width && prev.height === height
					? prev
					: { width, height },
			);
		};

		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(canvas);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const { width, height } = size;
		if (width <= 0 || height <= 0) return;

		const dpr = Math.min(3, window.devicePixelRatio || 1);
		canvas.width = Math.round(width * dpr);
		canvas.height = Math.round(height * dpr);

		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, width, height);

		const buckets = envelope?.length ?? 0;
		const span = end - start;
		if (!buckets || span <= 0 || !Number.isFinite(duration) || duration <= 0)
			return;

		const centre = height / 2;
		const scale = centre * AMPLITUDE;

		// One averaged sample per pixel column, so zooming out never aliases the
		// envelope into noise and zooming in never draws a staircase.
		const tops: number[] = new Array(width + 1);
		for (let x = 0; x <= width; x += 1) {
			const from = start + (x / width) * span;
			const to = start + ((x + 1) / width) * span;
			const first = Math.max(0, Math.floor((from / duration) * buckets));
			const last = Math.min(buckets - 1, Math.ceil((to / duration) * buckets));

			let total = 0;
			let count = 0;
			for (let index = first; index <= last; index += 1) {
				total += envelope?.[index] ?? 0;
				count += 1;
			}
			tops[x] = count > 0 ? total / count : 0;
		}

		ctx.beginPath();
		ctx.moveTo(0, centre - (tops[0] ?? 0) * scale);
		for (let x = 1; x <= width; x += 1) {
			ctx.lineTo(x, centre - (tops[x] ?? 0) * scale);
		}
		for (let x = width; x >= 0; x -= 1) {
			ctx.lineTo(x, centre + (tops[x] ?? 0) * scale);
		}
		ctx.closePath();
		ctx.fillStyle = FILL;
		ctx.fill();
	}, [envelope, start, end, duration, size]);

	return (
		<canvas
			ref={canvasRef}
			aria-hidden
			className="pointer-events-none absolute inset-0 size-full"
		/>
	);
});
