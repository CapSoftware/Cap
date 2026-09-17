import { createEffect, onCleanup } from "solid-js";
import { useEditorContext } from "../context";
import { useSegmentContext, useTimelineContext } from "./context";
import type { ImportedWaveform } from "./imported-waveform-data";
import { waveformRangeMax } from "./imported-waveform-data";

const MAX_CANVAS_WIDTH = 2000;
const MAX_DRAW_SAMPLES = 6000;

export function ImportedWaveformCanvas(props: {
	waveform?: ImportedWaveform;
	start: number;
	end: number;
	sourceStart: number;
	volumeDb: number;
	enabled: boolean;
	color: string;
}) {
	const { editorState } = useEditorContext();
	const { timelineBounds } = useTimelineContext();
	const { width } = useSegmentContext();
	let canvas: HTMLCanvasElement | undefined;
	let frame: number | undefined;

	function render() {
		frame = undefined;
		if (!canvas) return;
		const context = canvas.getContext("2d");
		if (!context) return;
		const duration = props.end - props.start;
		const fullWidth = width();
		const waveform = props.waveform;
		const peaks = waveform?.levels[0];
		if (
			!props.enabled ||
			props.volumeDb <= -30 ||
			!waveform ||
			!peaks?.length ||
			duration <= 0 ||
			fullWidth <= 0
		) {
			canvas.width = 1;
			return;
		}
		const transform = editorState.timeline.transform;
		const visibleStart = Math.max(props.start, transform.position);
		const visibleEnd = Math.min(props.end, transform.position + transform.zoom);
		if (visibleEnd <= visibleStart) {
			canvas.width = 1;
			return;
		}
		const pixelsPerSecond = fullWidth / duration;
		const virtualized = fullWidth > MAX_CANVAS_WIDTH;
		const rangeStart = virtualized ? visibleStart - props.start : 0;
		const rangeEnd = virtualized ? visibleEnd - props.start : duration;
		const renderedWidth = virtualized
			? Math.min(
					(rangeEnd - rangeStart) * pixelsPerSecond,
					(timelineBounds.width ?? 800) + 200,
				)
			: fullWidth;
		const canvasWidth = Math.max(
			1,
			Math.min(MAX_CANVAS_WIDTH, Math.ceil(renderedWidth)),
		);
		if (canvas.width !== canvasWidth) canvas.width = canvasWidth;
		canvas.style.left = `${rangeStart * pixelsPerSecond}px`;
		canvas.style.width = `${renderedWidth}px`;
		context.clearRect(0, 0, canvasWidth, canvas.height);
		const samples = Math.max(
			1,
			Math.min(
				MAX_DRAW_SAMPLES,
				Math.ceil(canvasWidth * 2),
				Math.ceil((rangeEnd - rangeStart) * 10),
			),
		);
		const step = (rangeEnd - rangeStart) / samples;
		const scale = Math.max(0, (props.volumeDb + 30) / 30);
		context.beginPath();
		context.moveTo(0, canvas.height);
		for (let index = 0; index <= samples; index++) {
			const time = rangeStart + index * step;
			const source = props.sourceStart + time;
			const peak = waveformRangeMax(
				waveform,
				source * 10,
				(source + step) * 10,
			);
			context.lineTo(
				(index / samples) * canvasWidth,
				canvas.height * (1 - (peak / 255) * scale),
			);
		}
		context.lineTo(canvasWidth, canvas.height);
		context.closePath();
		context.fillStyle = getComputedStyle(canvas).color;
		context.globalAlpha = 0.55;
		context.fill();
		context.globalAlpha = 1;
	}

	createEffect(() => {
		width();
		timelineBounds.width;
		editorState.timeline.transform.position;
		editorState.timeline.transform.zoom;
		props.waveform;
		props.start;
		props.end;
		props.sourceStart;
		props.volumeDb;
		props.enabled;
		if (frame !== undefined) cancelAnimationFrame(frame);
		frame = requestAnimationFrame(render);
	});
	onCleanup(() => {
		if (frame !== undefined) cancelAnimationFrame(frame);
	});
	return (
		<canvas
			ref={(element) => {
				canvas = element;
			}}
			class="absolute bottom-0 h-[18px] pointer-events-none"
			style={{ left: "0px", color: props.color }}
			height={52}
		/>
	);
}
