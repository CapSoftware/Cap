import { createElementBounds } from "@solid-primitives/bounds";
import { createEventListenerMap } from "@solid-primitives/event-listener";
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
	const barBounds = createElementBounds(barRef);

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
						// Anchoring the zoom at the opposite edge keeps that edge
						// pinned exactly: updateZoom's origin math resolves to
						// originPercentage 1 (left handle) or 0 (right handle).
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

	return (
		<div
			ref={setBarRef}
			class={cx(
				"relative w-full h-full overflow-hidden rounded-full border border-gray-4 bg-gray-3/80 transition-opacity duration-200",
				zoomedIn() ? "opacity-100" : "pointer-events-none opacity-0",
			)}
			onMouseDown={handleBarMouseDown}
			onMouseMove={(e) => {
				e.stopPropagation();
				setEditorState("previewTime", null);
			}}
		>
			<For each={clipBoundaries()}>
				{(offset) => (
					<div
						class="absolute inset-y-0 w-px bg-gray-6/50"
						style={{ left: `${(offset / total()) * 100}%` }}
					/>
				)}
			</For>
			<div
				class="absolute inset-y-0 rounded-full border border-gray-7/80 bg-gray-6/70 transition-colors duration-150 cursor-grab hover:bg-gray-7/70 active:cursor-grabbing"
				style={{ left: `${chipLeft()}px`, width: `${chipWidth()}px` }}
				onMouseDown={(e) => beginDrag(e, "move")}
			>
				<div
					class="absolute inset-y-0 left-0 w-2 cursor-col-resize"
					onMouseDown={(e) => beginDrag(e, "left")}
				/>
				<div
					class="absolute inset-y-0 right-0 w-2 cursor-col-resize"
					onMouseDown={(e) => beginDrag(e, "right")}
				/>
			</div>
		</div>
	);
}
