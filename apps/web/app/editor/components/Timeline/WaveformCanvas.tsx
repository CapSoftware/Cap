"use client";

import { useCallback, useEffect, useRef } from "react";

interface WaveformCanvasProps {
	peaks: Float32Array | number[];
	width: number;
	height: number;
	color?: string;
	backgroundColor?: string;
	barWidth?: number;
	barGap?: number;
	mirror?: boolean;
}

export function WaveformCanvas({
	peaks,
	width,
	height,
	color = "rgba(59, 130, 246, 0.6)",
	backgroundColor = "transparent",
	barWidth = 2,
	barGap = 1,
	mirror = true,
}: WaveformCanvasProps) {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	const draw = useCallback(() => {
		const canvas = canvasRef.current;
		if (!canvas || peaks.length === 0) return;

		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		const dpr = window.devicePixelRatio || 1;
		canvas.width = width * dpr;
		canvas.height = height * dpr;
		ctx.scale(dpr, dpr);

		ctx.fillStyle = backgroundColor;
		ctx.fillRect(0, 0, width, height);

		const totalBarWidth = barWidth + barGap;
		const barCount = Math.floor(width / totalBarWidth);
		const samplesPerBar = peaks.length / barCount;

		ctx.fillStyle = color;

		for (let i = 0; i < barCount; i++) {
			const startSample = Math.floor(i * samplesPerBar);
			const endSample = Math.min(
				Math.ceil((i + 1) * samplesPerBar),
				peaks.length,
			);

			let max = 0;
			for (let j = startSample; j < endSample; j++) {
				const peak = peaks[j];
				if (peak !== undefined) {
					const value = Math.abs(peak);
					if (value > max) max = value;
				}
			}

			const barHeight = Math.max(1, max * height * (mirror ? 0.5 : 1));
			const x = i * totalBarWidth;

			if (mirror) {
				const centerY = height / 2;
				ctx.fillRect(x, centerY - barHeight, barWidth, barHeight * 2);
			} else {
				ctx.fillRect(x, height - barHeight, barWidth, barHeight);
			}
		}
	}, [peaks, width, height, color, backgroundColor, barWidth, barGap, mirror]);

	useEffect(() => {
		draw();
	}, [draw]);

	return (
		<canvas
			ref={canvasRef}
			style={{
				width: `${width}px`,
				height: `${height}px`,
			}}
			className="pointer-events-none"
		/>
	);
}

export type { WaveformCanvasProps };
