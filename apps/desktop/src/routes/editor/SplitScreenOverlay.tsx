import { createEventListenerMap } from "@solid-primitives/event-listener";
import { cx } from "cva";
import { createMemo, createRoot, For, Show } from "solid-js";

import type { SplitLayout, XY } from "~/utils/tauri";
import { useEditorContext } from "./context";
import { DEFAULT_SPLIT_LAYOUT } from "./projectConfig";

type Props = {
	size: { width: number; height: number };
};

type Rect = { left: number; top: number; width: number; height: number };
type Dir = { x: -1 | 0 | 1; y: -1 | 0 | 1 };

const MIN_ZOOM = 1;
const MAX_ZOOM = 3;
// An outward drag of roughly one pane-extent maps to this much zoom change.
const ZOOM_DRAG_RANGE = 2.5;

const clamp = (v: number, min: number, max: number) =>
	Math.max(min, Math.min(max, v));

// Corner + edge resize handles. `dir` points outward from the pane centre, so
// `dx*dir.x + dy*dir.y` is positive when the handle is dragged away from centre
// (zoom in) and negative when dragged toward it (zoom out).
const HANDLES: { dir: Dir; class: string }[] = [
	{
		dir: { x: -1, y: -1 },
		class: "top-0 left-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize",
	},
	{
		dir: { x: 1, y: -1 },
		class: "top-0 right-0 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize",
	},
	{
		dir: { x: -1, y: 1 },
		class:
			"bottom-0 left-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize",
	},
	{
		dir: { x: 1, y: 1 },
		class:
			"bottom-0 right-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize",
	},
	{
		dir: { x: 0, y: -1 },
		class: "top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize",
	},
	{
		dir: { x: 0, y: 1 },
		class:
			"bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 cursor-ns-resize",
	},
	{
		dir: { x: -1, y: 0 },
		class: "top-1/2 left-0 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize",
	},
	{
		dir: { x: 1, y: 0 },
		class: "top-1/2 right-0 translate-x-1/2 -translate-y-1/2 cursor-ew-resize",
	},
];

// In-canvas controls for the split-screen panes. Drag a pane to pan its focal
// point; drag a resize handle to scale (zoom) its content. Writes the same
// `splitLayout` fields the sidebar sliders use, so the two stay in sync. The
// pane outline and handles only appear on hover, and the overlay is shown only
// while a split-screen scene segment is selected with the playhead inside it
// (so the handles line up with the rendered halves).
export function SplitScreenOverlay(props: Props) {
	const { project, setProject, editorState, projectHistory } =
		useEditorContext();

	const currentTime = () =>
		editorState.previewTime ?? editorState.playbackTime ?? 0;

	const active = createMemo(() => {
		const selection = editorState.timeline.selection;
		if (!selection || selection.type !== "scene") return null;
		const index = selection.indices[0];
		if (index === undefined) return null;
		const segment = project.timeline?.sceneSegments?.[index];
		if (!segment || segment.mode !== "splitScreen") return null;
		const time = currentTime();
		if (time < segment.start || time >= segment.end) return null;
		return { index, segment };
	});

	const split = (): SplitLayout =>
		active()?.segment.splitLayout ?? DEFAULT_SPLIT_LAYOUT;

	// Matches the renderer: landscape output lays panes left/right, portrait
	// stacks them top/bottom (crates/rendering SPLIT_STACK_ASPECT_THRESHOLD).
	const horizontal = () => props.size.width >= props.size.height;

	const screenRect = (): Rect =>
		horizontal()
			? {
					left: 0,
					top: 0,
					width: props.size.width / 2,
					height: props.size.height,
				}
			: {
					left: 0,
					top: 0,
					width: props.size.width,
					height: props.size.height / 2,
				};
	const cameraRect = (): Rect =>
		horizontal()
			? {
					left: props.size.width / 2,
					top: 0,
					width: props.size.width / 2,
					height: props.size.height,
				}
			: {
					left: 0,
					top: props.size.height / 2,
					width: props.size.width,
					height: props.size.height / 2,
				};

	const updateSplit = (patch: Partial<SplitLayout>) => {
		const a = active();
		if (!a) return;
		setProject("timeline", "sceneSegments", a.index, "splitLayout", {
			...(a.segment.splitLayout ?? DEFAULT_SPLIT_LAYOUT),
			...patch,
		});
	};

	function createDrag<T>(
		setup: () => T,
		update: (
			e: MouseEvent,
			value: T,
			initialMouse: { x: number; y: number },
		) => void,
	) {
		return (downEvent: MouseEvent) => {
			downEvent.preventDefault();
			downEvent.stopPropagation();
			const value = setup();
			const initialMouse = { x: downEvent.clientX, y: downEvent.clientY };
			const resumeHistory = projectHistory.pause();
			createRoot((dispose) => {
				createEventListenerMap(window, {
					mousemove: (e) => update(e, value, initialMouse),
					mouseup: () => {
						resumeHistory();
						dispose();
					},
				});
			});
		};
	}

	const makePan = (
		getPos: () => XY<number>,
		getZoom: () => number,
		rect: () => Rect,
		write: (pos: XY<number>) => void,
	) =>
		createDrag(
			() => ({
				start: { ...getPos() },
				zoom: Math.max(getZoom(), 0.01),
				rect: rect(),
			}),
			(e, { start, zoom, rect }, m) => {
				// Dragging the content moves the crop window the opposite way;
				// dividing by zoom keeps panning proportional to the visible slice.
				const dx = (e.clientX - m.x) / rect.width / zoom;
				const dy = (e.clientY - m.y) / rect.height / zoom;
				write({ x: clamp(start.x - dx, 0, 1), y: clamp(start.y - dy, 0, 1) });
			},
		);

	const makeResize = (
		dir: Dir,
		getZoom: () => number,
		rect: () => Rect,
		write: (zoom: number) => void,
	) =>
		createDrag(
			() => ({ zoom: getZoom(), rect: rect() }),
			(e, { zoom, rect }, m) => {
				const dx = (e.clientX - m.x) / rect.width;
				const dy = (e.clientY - m.y) / rect.height;
				const outward = dx * dir.x + dy * dir.y;
				write(clamp(zoom + outward * ZOOM_DRAG_RANGE, MIN_ZOOM, MAX_ZOOM));
			},
		);

	return (
		<Show when={active()}>
			<div class="absolute inset-0 pointer-events-none">
				<Pane
					rect={screenRect()}
					onPan={makePan(
						() => split().screenPosition,
						() => split().screenZoom,
						screenRect,
						(pos) => updateSplit({ screenPosition: pos }),
					)}
					makeResize={(dir) =>
						makeResize(
							dir,
							() => split().screenZoom,
							screenRect,
							(zoom) => updateSplit({ screenZoom: zoom }),
						)
					}
				/>
				<Pane
					rect={cameraRect()}
					onPan={makePan(
						() => split().cameraPosition,
						() => split().cameraZoom,
						cameraRect,
						(pos) => updateSplit({ cameraPosition: pos }),
					)}
					makeResize={(dir) =>
						makeResize(
							dir,
							() => split().cameraZoom,
							cameraRect,
							(zoom) => updateSplit({ cameraZoom: zoom }),
						)
					}
				/>
			</div>
		</Show>
	);
}

function Pane(props: {
	rect: Rect;
	onPan: (e: MouseEvent) => void;
	makeResize: (dir: Dir) => (e: MouseEvent) => void;
}) {
	return (
		<div
			class="absolute pointer-events-auto cursor-move group"
			style={{
				left: `${props.rect.left}px`,
				top: `${props.rect.top}px`,
				width: `${props.rect.width}px`,
				height: `${props.rect.height}px`,
			}}
			onMouseDown={props.onPan}
		>
			<div class="absolute inset-0 rounded-sm border-2 border-blue-9/80 bg-blue-9/10 opacity-0 transition-opacity duration-150 pointer-events-none group-hover:opacity-100" />
			<For each={HANDLES}>
				{(handle) => (
					<div
						class={cx(
							"absolute w-3 h-3 rounded-full border border-white bg-blue-9 shadow-sm opacity-0 transition-opacity duration-150 group-hover:opacity-100 hover:scale-125",
							handle.class,
						)}
						onMouseDown={props.makeResize(handle.dir)}
					/>
				)}
			</For>
		</div>
	);
}
