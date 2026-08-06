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

// Floating-cards geometry. Matches the renderer's FLOATING_* constants
// (crates/rendering/src/lib.rs) so the drag panes line up with the cards.
const FLOATING_PADDING_FRAC = 0.05;
const FLOATING_CAMERA_FRAC = 0.3;
const FLOATING_CAMERA_FRAC_STACKED = 0.4;

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

// In-canvas controls for the split-screen and floating-cards panes. Drag a
// pane to pan its focal point; drag a resize handle to scale (zoom) its
// content. Writes the same `splitLayout` fields the sidebar sliders use, so
// the two stay in sync. The pane outline and handles only appear on hover, and
// the overlay is shown only while a split-screen/floating scene segment is
// selected with the playhead inside it (so the handles line up with the
// rendered panes).
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
		if (
			!segment ||
			(segment.mode !== "splitScreen" && segment.mode !== "floating")
		)
			return null;
		const time = currentTime();
		if (time < segment.start || time >= segment.end) return null;
		return { index, segment };
	});

	const split = (): SplitLayout =>
		active()?.segment.splitLayout ?? DEFAULT_SPLIT_LAYOUT;

	const floating = () => active()?.segment.mode === "floating";

	// Matches the renderer: landscape output lays panes left/right, portrait
	// stacks them top/bottom (crates/rendering SPLIT_STACK_ASPECT_THRESHOLD).
	const horizontal = () => props.size.width >= props.size.height;

	// Screen + camera pane rects, mirroring the renderer's geometry for the
	// active mode: full-bleed halves for split-screen, padded cards for
	// floating.
	const rects = (): { screen: Rect; camera: Rect } => {
		const { width: w, height: h } = props.size;
		if (floating()) {
			const pad = Math.min(w, h) * FLOATING_PADDING_FRAC;
			if (horizontal()) {
				const contentW = Math.max(w - pad * 3, 2);
				const cameraW = contentW * FLOATING_CAMERA_FRAC;
				return {
					screen: {
						left: pad,
						top: pad,
						width: contentW - cameraW,
						height: h - pad * 2,
					},
					camera: {
						left: w - pad - cameraW,
						top: pad,
						width: cameraW,
						height: h - pad * 2,
					},
				};
			}
			const contentH = Math.max(h - pad * 3, 2);
			const cameraH = contentH * FLOATING_CAMERA_FRAC_STACKED;
			return {
				screen: {
					left: pad,
					top: pad,
					width: w - pad * 2,
					height: contentH - cameraH,
				},
				camera: {
					left: pad,
					top: h - pad - cameraH,
					width: w - pad * 2,
					height: cameraH,
				},
			};
		}
		return horizontal()
			? {
					screen: { left: 0, top: 0, width: w / 2, height: h },
					camera: { left: w / 2, top: 0, width: w / 2, height: h },
				}
			: {
					screen: { left: 0, top: 0, width: w, height: h / 2 },
					camera: { left: 0, top: h / 2, width: w, height: h / 2 },
				};
	};

	const screenRect = (): Rect => rects().screen;
	const cameraRect = (): Rect => rects().camera;

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
					rounded={floating()}
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
					rounded={floating()}
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
	rounded?: boolean;
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
			<div
				class={cx(
					"absolute inset-0 border-2 border-blue-9/80 bg-blue-9/10 opacity-0 transition-opacity duration-150 pointer-events-none group-hover:opacity-100",
					props.rounded ? "rounded-2xl" : "rounded-sm",
				)}
			/>
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
