import { createElementBounds } from "@solid-primitives/bounds";
import {
	createEventListener,
	createEventListenerMap,
} from "@solid-primitives/event-listener";
import { cx } from "cva";
import { createMemo, createRoot, createSignal, For, onCleanup } from "solid-js";

import { clipTimelineOffsets } from "../clip-transitions";
import { useEditorContext } from "../context";

const MIN_CHIP_WIDTH = 20;

export function Minimap() {
	const { project, editorState, setEditorState, totalDuration } =
		useEditorContext();
	const transform = () => editorState.timeline.transform;

	const [barRef, setBarRef] = createSignal<HTMLDivElement>();
	const barBounds = createElementBounds(barRef, { trackMutation: false });

	const total = () => Math.max(totalDuration(), 0.001);
	const barWidth = () => Math.max(barBounds.width ?? 0, 1);
	const pxPerSec = () => barWidth() / total();
	const zoomedIn = () => total() - transform().zoom > 0.01;

	const chipWidth = () =>
		Math.min(
			Math.max(transform().zoom * pxPerSec(), MIN_CHIP_WIDTH),
			barWidth(),
		);
	const chipLeft = () => {
		const maxPosition = Math.max(total() - transform().zoom, 0.001);
		const fraction = Math.min(transform().position / maxPosition, 1);
		return fraction * Math.max(barWidth() - chipWidth(), 0);
	};

	const clipBoundaries = createMemo(() => {
		const timeline = project.timeline;
		if (!timeline || timeline.segments.length < 2) return [];
		return clipTimelineOffsets(timeline.segments, timeline.transitions ?? [])
			.slice(1)
			.filter((offset) => offset > 0 && offset < total());
	});

	function beginDrag(downEvent: MouseEvent, mode: "move" | "left" | "right") {
		if (downEvent.button !== 0) return;
		downEvent.stopPropagation();

		const startX = downEvent.clientX;
		const startPosition = transform().position;
		const startZoom = transform().zoom;
		const anchorStart = startPosition;
		const anchorEnd = startPosition + startZoom;
		const moveScale =
			(total() - startZoom) / Math.max(barWidth() - chipWidth(), 1);

		createRoot((dispose) => {
			const previousCursor = document.body.style.cursor;
			document.body.style.cursor = mode === "move" ? "grabbing" : "col-resize";
			onCleanup(() => {
				document.body.style.cursor = previousCursor;
			});

			createEventListenerMap(window, {
				mousemove: (event) => {
					setEditorState("previewTime", null);
					const deltaX = event.clientX - startX;
					if (mode === "move") {
						transform().setPosition(startPosition + deltaX * moveScale);
					} else if (mode === "left") {
						transform().updateZoom(startZoom - deltaX / pxPerSec(), anchorEnd);
					} else {
						transform().updateZoom(
							startZoom + deltaX / pxPerSec(),
							anchorStart,
						);
					}
				},
				mouseup: () => dispose(),
				blur: () => dispose(),
			});
		});
	}

	function handleBarMouseDown(downEvent: MouseEvent) {
		if (downEvent.button !== 0) return;
		downEvent.stopPropagation();

		const bar = barRef();
		if (!bar) return;
		const rect = bar.getBoundingClientRect();
		const clickTime = ((downEvent.clientX - rect.left) / barWidth()) * total();
		transform().setPosition(clickTime - transform().zoom / 2);
		beginDrag(downEvent, "move");
	}

	createEventListener(barRef, "mousedown", (event: MouseEvent) => {
		if ((event.target as Element | null)?.closest("[role='slider']")) return;
		handleBarMouseDown(event);
	});
	createEventListener(barRef, "mousemove", (event: MouseEvent) => {
		event.stopPropagation();
		setEditorState("previewTime", null);
	});

	const panWithKeyboard = (event: KeyboardEvent) => {
		const step = transform().zoom * (event.shiftKey ? 1 : 0.1);
		const position = transform().position;
		const next =
			event.key === "ArrowLeft"
				? position - step
				: event.key === "ArrowRight"
					? position + step
					: event.key === "Home"
						? 0
						: event.key === "End"
							? total() - transform().zoom
							: null;
		if (next === null) return;
		event.preventDefault();
		event.stopPropagation();
		transform().setPosition(next);
	};

	const resizeWithKeyboard = (event: KeyboardEvent, edge: "left" | "right") => {
		const direction =
			event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
		if (direction === 0) return;
		event.preventDefault();
		event.stopPropagation();
		const step = transform().zoom * (event.shiftKey ? 0.5 : 0.1);
		const start = transform().position;
		const end = start + transform().zoom;
		if (edge === "left")
			transform().updateZoom(transform().zoom - direction * step, end);
		else transform().updateZoom(transform().zoom + direction * step, start);
	};

	const focusable = () => (zoomedIn() ? 0 : -1);
	const seconds = (value: number) => Math.round(value * 10) / 10;

	return (
		<div
			ref={setBarRef}
			aria-hidden={zoomedIn() ? undefined : "true"}
			class={cx(
				"relative w-full h-full overflow-hidden rounded-[2px] bg-ed-ctl-active transition-opacity duration-200",
				zoomedIn() ? "opacity-100" : "pointer-events-none opacity-0",
			)}
		>
			<For each={clipBoundaries()}>
				{(offset) => (
					<div
						class="absolute inset-y-0 w-px opacity-50"
						style={{
							left: `${(offset / total()) * 100}%`,
							background: "var(--track-clip)",
						}}
					/>
				)}
			</For>
			<div
				role="slider"
				tabIndex={focusable()}
				aria-label="Visible part of the timeline"
				aria-valuemin={0}
				aria-valuemax={seconds(Math.max(total() - transform().zoom, 0))}
				aria-valuenow={seconds(transform().position)}
				class="absolute inset-y-0 rounded-[2px] bg-ed-text-3/50 transition-colors duration-150 cursor-grab hover:bg-ed-text-3/75 active:cursor-grabbing outline-hidden focus-visible:bg-ed-text-3/75"
				style={{ left: `${chipLeft()}px`, width: `${chipWidth()}px` }}
				onMouseDown={(e) => beginDrag(e, "move")}
				onKeyDown={panWithKeyboard}
			>
				<div
					role="slider"
					tabIndex={focusable()}
					aria-label="Start of the visible part"
					aria-valuemin={0}
					aria-valuemax={seconds(total())}
					aria-valuenow={seconds(transform().position)}
					class="absolute inset-y-0 left-0 w-2 cursor-col-resize outline-hidden focus-visible:bg-ed-text-1/40"
					onMouseDown={(e) => beginDrag(e, "left")}
					onKeyDown={(e) => resizeWithKeyboard(e, "left")}
				/>
				<div
					role="slider"
					tabIndex={focusable()}
					aria-label="End of the visible part"
					aria-valuemin={0}
					aria-valuemax={seconds(total())}
					aria-valuenow={seconds(transform().position + transform().zoom)}
					class="absolute inset-y-0 right-0 w-2 cursor-col-resize outline-hidden focus-visible:bg-ed-text-1/40"
					onMouseDown={(e) => beginDrag(e, "right")}
					onKeyDown={(e) => resizeWithKeyboard(e, "right")}
				/>
			</div>
		</div>
	);
}
