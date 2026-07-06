import {
	createEventListener,
	createEventListenerMap,
} from "@solid-primitives/event-listener";
import { throttle } from "@solid-primitives/scheduled";
import { cx } from "cva";
import {
	batch,
	createEffect,
	createMemo,
	createRoot,
	createSignal,
	For,
	on,
	Show,
} from "solid-js";
import type { FrameLayoutEvent } from "~/utils/tauri";
import { FPS, useEditorContext } from "./context";
import {
	buildSnapTargets,
	type NormRect,
	SNAP_PX,
	type SnapTargets,
	snapMovingRect,
	snapResizeCorner,
} from "./snapping";

// In-canvas move/resize controls for the screen recording (display) and the
// camera. Boxes track the exact rects the renderer reported for the latest
// frame (FrameLayoutEvent), so they always match the pixels on screen; drags
// write normalized centers back to the project config, which both the preview
// and the exporter consume through the same layout code.

type Size = { width: number; height: number };

const clamp = (value: number, min: number, max: number) =>
	min > max ? (min + max) / 2 : Math.min(Math.max(value, min), max);

function normRect(
	bounds: [number, number, number, number],
	layout: FrameLayoutEvent,
): NormRect {
	return {
		x: bounds[0] / layout.output_width,
		y: bounds[1] / layout.output_height,
		w: (bounds[2] - bounds[0]) / layout.output_width,
		h: (bounds[3] - bounds[1]) / layout.output_height,
	};
}

// The renderer's classic camera inset (CAMERA_PADDING px at 1080p), exposed
// as snap lines so a freely-dragged camera can land back on the stock look.
function classicMargin(layout: FrameLayoutEvent) {
	const padPx = 50 * (layout.output_height / 1080);
	return { x: padPx / layout.output_width, y: padPx / layout.output_height };
}

type SnapExclude =
	| "display"
	| "camera"
	| { text: number }
	| { mask: number }
	| null;

/**
 * Snap-target factory shared by every preview overlay: frame edges/center,
 * the classic camera margin, and the other visible elements' edges/centers,
 * excluding whichever element is being dragged.
 */
export function useCanvasSnapTargets() {
	const { project, editorState, latestFrameLayout } = useEditorContext();
	const time = () => editorState.previewTime ?? editorState.playbackTime ?? 0;

	return (exclude: SnapExclude): SnapTargets => {
		const rects: NormRect[] = [];
		const layout = latestFrameLayout();

		if (layout) {
			if (exclude !== "display") rects.push(normRect(layout.display, layout));
			if (layout.camera && exclude !== "camera")
				rects.push(normRect(layout.camera, layout));
		}

		const t = time();
		project.timeline?.textSegments?.forEach((segment, index) => {
			if (
				typeof exclude === "object" &&
				exclude !== null &&
				"text" in exclude &&
				exclude.text === index
			)
				return;
			if (!(t >= segment.start && t < segment.end)) return;
			if (segment.enabled === false) return;
			const center = segment.center ?? { x: 0.5, y: 0.5 };
			const size = segment.size ?? { x: 0.35, y: 0.2 };
			rects.push({
				x: center.x - size.x / 2,
				y: center.y - size.y / 2,
				w: size.x,
				h: size.y,
			});
		});
		project.timeline?.maskSegments?.forEach((segment, index) => {
			if (
				typeof exclude === "object" &&
				exclude !== null &&
				"mask" in exclude &&
				exclude.mask === index
			)
				return;
			if (!(t >= segment.start && t < segment.end)) return;
			rects.push({
				x: segment.center.x - segment.size.x / 2,
				y: segment.center.y - segment.size.y / 2,
				w: segment.size.x,
				h: segment.size.y,
			});
		});

		// The classic camera-inset margin lines only make sense for the camera
		// and display; for text/mask boxes they just cause spurious re-snaps
		// right next to the frame-edge lines.
		const wantsMargin = exclude === "camera" || exclude === "display";
		return buildSnapTargets(rects, {
			margin: layout && wantsMargin ? classicMargin(layout) : undefined,
		});
	};
}

/** Renders the active smart-guide lines. Mounted above all other overlays. */
export function SnapGuidesOverlay(props: { size: Size }) {
	const { snapGuides } = useEditorContext();
	return (
		<div class="overflow-hidden absolute inset-0 pointer-events-none">
			<For each={snapGuides()}>
				{(guide) => (
					<div
						class="absolute bg-[#FF3B6B]"
						style={
							guide.axis === "v"
								? {
										left: `${guide.pos * props.size.width}px`,
										top: `${guide.start * props.size.height}px`,
										width: "1px",
										height: `${(guide.end - guide.start) * props.size.height}px`,
									}
								: {
										top: `${guide.pos * props.size.height}px`,
										left: `${guide.start * props.size.width}px`,
										height: "1px",
										width: `${(guide.end - guide.start) * props.size.width}px`,
									}
						}
					/>
				)}
			</For>
		</div>
	);
}

export function CanvasElementsOverlay(props: { size: Size }) {
	const {
		project,
		setProject,
		editorState,
		setEditorState,
		projectHistory,
		latestFrameLayout,
		setSnapGuides,
	} = useEditorContext();

	const snapTargetsFor = useCanvasSnapTargets();

	const time = () => editorState.previewTime ?? editorState.playbackTime ?? 0;

	const sceneModeAt = (t: number) =>
		project.timeline?.sceneSegments?.find((s) => t >= s.start && t < s.end)
			?.mode ?? "default";

	const activeZoomIndex = () => {
		const t = time();
		const index = (project.timeline?.zoomSegments ?? []).findIndex(
			(s) => t >= s.start && t < s.end,
		);
		return index === -1 ? null : index;
	};
	const zoomActive = () => activeZoomIndex() !== null;

	// Jumping to the zoom segment is the clearest answer to "why is this
	// locked?" — the segment highlights in the timeline and its settings open
	// in the sidebar, where the zoom can be adjusted or deleted.
	const selectActiveZoom = () => {
		const index = activeZoomIndex();
		if (index === null) return;
		batch(() => {
			setEditorState("canvasSelection", null);
			setEditorState("timeline", "selection", {
				type: "zoom",
				indices: [index],
			});
		});
	};

	// Optimistic rects follow the pointer at input rate during a drag; the
	// video catches up a frame later. Cleared once the next rendered layout
	// arrives so the box never flashes back to a stale position.
	const [dragRects, setDragRects] = createSignal<{
		display?: NormRect;
		camera?: NormRect;
	} | null>(null);
	let dragging = false;

	createEffect(
		on(
			latestFrameLayout,
			() => {
				if (!dragging) setDragRects(null);
			},
			{ defer: true },
		),
	);

	const displayRect = createMemo<NormRect | null>(() => {
		const optimistic = dragRects()?.display;
		if (optimistic) return optimistic;
		const layout = latestFrameLayout();
		return layout ? normRect(layout.display, layout) : null;
	});

	const cameraRect = createMemo<NormRect | null>(() => {
		const optimistic = dragRects()?.camera;
		if (optimistic) return optimistic;
		const layout = latestFrameLayout();
		return layout?.camera ? normRect(layout.camera, layout) : null;
	});

	const overlayVisible = () => !editorState.playing && !!latestFrameLayout();
	const paneScene = () => {
		const mode = sceneModeAt(time());
		return mode === "splitScreen" || mode === "floating";
	};
	const showDisplay = () =>
		overlayVisible() && !paneScene() && sceneModeAt(time()) !== "cameraOnly";
	const showCamera = () => overlayVisible() && !paneScene();
	// The rendered display rect is zoom-transformed while a zoom segment is
	// active, but drags write base-layout config — lock it to avoid a
	// mismatched pointer feel. Camera placement is not zoom-transformed.
	const displayDraggable = () => !zoomActive();
	const cameraResizable = () => !zoomActive();

	const selection = () => editorState.canvasSelection;
	const select = (type: "display" | "camera") =>
		batch(() => {
			setEditorState("canvasSelection", { type });
			setEditorState("timeline", "selection", null);
		});

	// Selecting a timeline segment drops the canvas selection (and vice versa
	// in `select`), so only one selection UI is active at a time.
	createEffect(
		on(
			() => editorState.timeline.selection,
			(timelineSelection) => {
				if (timelineSelection) setEditorState("canvasSelection", null);
			},
			{ defer: true },
		),
	);

	const thresholds = () => ({
		x: SNAP_PX / Math.max(props.size.width, 1),
		y: SNAP_PX / Math.max(props.size.height, 1),
	});

	function createCanvasDrag<T extends { moved: boolean }>(
		setup: () => T | null,
		update: (
			e: MouseEvent,
			value: T,
			initialMouse: { x: number; y: number },
		) => void,
	) {
		return (downEvent: MouseEvent) => {
			if (downEvent.button !== 0) return;
			const initial = setup();
			if (!initial) return;
			const state = initial;

			downEvent.preventDefault();
			downEvent.stopPropagation();

			const initialMouse = { x: downEvent.clientX, y: downEvent.clientY };
			const resumeHistory = projectHistory.pause();
			dragging = true;

			function handleUpdate(event: MouseEvent) {
				// A plain click must not write config (it would e.g. convert a
				// preset camera position into a manual one).
				if (
					!state.moved &&
					Math.hypot(
						event.clientX - initialMouse.x,
						event.clientY - initialMouse.y,
					) < 2
				)
					return;
				state.moved = true;
				update(event, state, initialMouse);
			}

			const throttledUpdate = throttle(handleUpdate, 1000 / FPS);

			function finish(finalEvent: MouseEvent) {
				throttledUpdate.clear();
				handleUpdate(finalEvent);
				resumeHistory();
				setSnapGuides([]);
				dragging = false;
				dispose();
			}

			const dispose = createRoot((dispose) => {
				createEventListenerMap(window, {
					mousemove: throttledUpdate,
					mouseup: finish,
				});
				return dispose;
			});
		};
	}

	const moveHandler = (element: "display" | "camera") =>
		createCanvasDrag(
			() => {
				const rect = element === "display" ? displayRect() : cameraRect();
				if (!rect) return null;
				if (element === "display" && !displayDraggable()) return null;
				return { rect, targets: snapTargetsFor(element), moved: false };
			},
			(e, state, initialMouse) => {
				const raw = {
					...state.rect,
					x: state.rect.x + (e.clientX - initialMouse.x) / props.size.width,
					y: state.rect.y + (e.clientY - initialMouse.y) / props.size.height,
				};

				let dx = 0;
				let dy = 0;
				if (e.shiftKey) {
					setSnapGuides([]);
				} else {
					const snap = snapMovingRect(
						raw,
						state.targets,
						thresholds().x,
						thresholds().y,
					);
					dx = snap.dx;
					dy = snap.dy;
					setSnapGuides(snap.guides);
				}

				// The display's center may go anywhere in-frame (it can overhang
				// edges, matching the renderer); the camera stays fully visible.
				const isDisplay = element === "display";
				const x = isDisplay
					? clamp(raw.x + dx, -raw.w / 2, 1 - raw.w / 2)
					: clamp(raw.x + dx, 0, Math.max(0, 1 - raw.w));
				const y = isDisplay
					? clamp(raw.y + dy, -raw.h / 2, 1 - raw.h / 2)
					: clamp(raw.y + dy, 0, Math.max(0, 1 - raw.h));
				const center = { x: x + raw.w / 2, y: y + raw.h / 2 };

				setDragRects((prev) => ({ ...prev, [element]: { ...raw, x, y } }));
				if (element === "display") {
					setProject("background", "displayPosition", center);
				} else {
					setProject("camera", "manualPosition", center);
				}
			},
		);

	const onDisplayMove = moveHandler("display");
	const onCameraMove = moveHandler("camera");

	// Aspect-locked corner resize: derive a scale factor from the pointer's
	// outward travel, snap the dragged corner, then map the scale onto the
	// config field (camera.size / background.padding). The optimistic rect
	// uses the same anchor the renderer will use, so the box and the video
	// stay glued.
	const resolveScale = (
		e: MouseEvent,
		state: { rect: NormRect; targets: SnapTargets },
		initialMouse: { x: number; y: number },
		dirX: 1 | -1,
		dirY: 1 | -1,
		anchor: { x: number; y: number },
	) => {
		const dxN = (e.clientX - initialMouse.x) / props.size.width;
		const dyN = (e.clientY - initialMouse.y) / props.size.height;
		const outward = dxN * dirX + dyN * dirY;
		let scale = 1 + (2 * outward) / (state.rect.w + state.rect.h);

		if (e.shiftKey) {
			setSnapGuides([]);
		} else {
			const corner0 = {
				x: state.rect.x + (dirX > 0 ? state.rect.w : 0),
				y: state.rect.y + (dirY > 0 ? state.rect.h : 0),
			};
			const rawCorner = {
				x: anchor.x + (corner0.x - anchor.x) * scale,
				y: anchor.y + (corner0.y - anchor.y) * scale,
			};
			const snap = snapResizeCorner(
				rawCorner,
				state.targets,
				thresholds().x,
				thresholds().y,
			);
			if (snap.axis === "x" && Math.abs(corner0.x - anchor.x) > 1e-6) {
				scale = (snap.x - anchor.x) / (corner0.x - anchor.x);
			} else if (snap.axis === "y" && Math.abs(corner0.y - anchor.y) > 1e-6) {
				scale = (snap.y - anchor.y) / (corner0.y - anchor.y);
			}
			setSnapGuides(snap.guides);
		}

		return Math.max(scale, 0.05);
	};

	const cameraResizeHandler = (dirX: 1 | -1, dirY: 1 | -1) =>
		createCanvasDrag(
			() => {
				const rect = cameraRect();
				const layout = latestFrameLayout();
				if (!rect || !layout || !cameraResizable()) return null;
				return {
					rect,
					layout,
					manual: project.camera.manualPosition,
					enumPos: { ...project.camera.position },
					targets: snapTargetsFor("camera"),
					moved: false,
				};
			},
			(e, state, initialMouse) => {
				const anchor = state.manual
					? {
							x: state.rect.x + state.rect.w / 2,
							y: state.rect.y + state.rect.h / 2,
						}
					: {
							// Without a manual position the renderer anchors the
							// camera at its preset corner/edge.
							x:
								state.enumPos.x === "left"
									? state.rect.x
									: state.enumPos.x === "center"
										? state.rect.x + state.rect.w / 2
										: state.rect.x + state.rect.w,
							y:
								state.enumPos.y === "top"
									? state.rect.y
									: state.rect.y + state.rect.h,
						};
				const scale = resolveScale(e, state, initialMouse, dirX, dirY, anchor);

				// camera.size is a percentage of the output's min axis, applied
				// to the camera's min dimension on top of a fixed padding.
				const { output_width: W, output_height: H } = state.layout;
				const minAxis = Math.min(W, H);
				const camPad = 50 * (H / 1080);
				const minDim0 = Math.min(state.rect.w * W, state.rect.h * H);
				const newSize = clamp(
					(((minDim0 * scale - camPad) / minAxis) * 100) as number,
					20,
					80,
				);
				setProject("camera", "size", newSize);

				const applied = ((newSize / 100) * minAxis + camPad) / minDim0;
				const w = state.rect.w * applied;
				const h = state.rect.h * applied;
				const x = clamp(
					anchor.x - (anchor.x - state.rect.x) * applied,
					0,
					Math.max(0, 1 - w),
				);
				const y = clamp(
					anchor.y - (anchor.y - state.rect.y) * applied,
					0,
					Math.max(0, 1 - h),
				);
				setDragRects((prev) => ({ ...prev, camera: { x, y, w, h } }));
			},
		);

	const displayResizeHandler = (dirX: 1 | -1, dirY: 1 | -1) =>
		createCanvasDrag(
			() => {
				const rect = displayRect();
				const layout = latestFrameLayout();
				if (!rect || !layout || !displayDraggable()) return null;

				const { output_width: W, output_height: H } = layout;
				const contentAspect = (rect.w * W) / Math.max(rect.h * H, 1e-6);
				const frameAspect = W / H;
				// Normalized display width at padding 0 (aspect-fit).
				const maxWidth = Math.min(1, contentAspect / frameAspect);
				// Mirror of the renderer's sizing law (get_base_size /
				// display_base_offset in crates/rendering):
				//   width = maxWidth / (1 + paddingScale * padding)
				// with padding in [0, 100] and paddingScale = 2k * 0.4 / 100
				// (0.4 = SCREEN_MAX_PADDING). Without a fixed aspect ratio the
				// padded base keeps the content aspect (k = 1); with one,
				// padding is measured against the crop's larger dimension
				// while the fit is constrained by a single axis, so k rescales
				// that basis onto the constrained axis.
				const k = !project.aspectRatio
					? 1
					: contentAspect <= frameAspect
						? Math.max(1, contentAspect)
						: Math.max(1, 1 / contentAspect);
				const paddingScale = (2 * k * 0.4) / 100;

				return {
					rect,
					targets: snapTargetsFor("display"),
					maxWidth,
					paddingScale,
					moved: false,
				};
			},
			(e, state, initialMouse) => {
				const anchor = {
					x: state.rect.x + state.rect.w / 2,
					y: state.rect.y + state.rect.h / 2,
				};
				const scale = resolveScale(e, state, initialMouse, dirX, dirY, anchor);

				// Invert the renderer's law for the dragged width, then re-derive
				// the outline from the clamped padding so the outline always lands
				// exactly where the renderer will draw the display — including at
				// the minimum size (padding 100).
				const targetWidth = Math.max(state.rect.w * scale, 1e-6);
				const newPadding = clamp(
					(state.maxWidth / targetWidth - 1) / state.paddingScale,
					0,
					100,
				);
				setProject("background", "padding", newPadding);

				const newWidth = state.maxWidth / (1 + state.paddingScale * newPadding);
				const applied = newWidth / state.rect.w;
				const w = state.rect.w * applied;
				const h = state.rect.h * applied;
				setDragRects((prev) => ({
					...prev,
					display: {
						x: clamp(anchor.x - w / 2, 0, Math.max(0, 1 - w)),
						y: clamp(anchor.y - h / 2, 0, Math.max(0, 1 - h)),
						w,
						h,
					},
				}));
			},
		);

	// Arrow-key nudge for the selected element (1px, Shift = 10px), Escape
	// deselects. Scoped here rather than useEditorShortcuts so held keys
	// repeat.
	createEventListener(document, "keydown", (e: KeyboardEvent) => {
		const selected = selection();
		if (!selected || !overlayVisible()) return;
		const target = e.target as HTMLElement | null;
		if (
			target &&
			(target.tagName === "INPUT" ||
				target.tagName === "TEXTAREA" ||
				target.isContentEditable)
		)
			return;

		if (e.key === "Escape") {
			setEditorState("canvasSelection", null);
			return;
		}

		const arrows: Record<string, [number, number]> = {
			ArrowLeft: [-1, 0],
			ArrowRight: [1, 0],
			ArrowUp: [0, -1],
			ArrowDown: [0, 1],
		};
		const dir = arrows[e.key];
		if (!dir) return;

		const isDisplay = selected.type === "display";
		if (isDisplay && (!showDisplay() || !displayDraggable())) return;
		if (!isDisplay && !showCamera()) return;
		const rect = isDisplay ? displayRect() : cameraRect();
		if (!rect) return;

		e.preventDefault();
		const px = e.shiftKey ? 10 : 1;
		const x = clamp(
			rect.x + (dir[0] * px) / props.size.width,
			isDisplay ? -rect.w / 2 : 0,
			isDisplay ? 1 - rect.w / 2 : Math.max(0, 1 - rect.w),
		);
		const y = clamp(
			rect.y + (dir[1] * px) / props.size.height,
			isDisplay ? -rect.h / 2 : 0,
			isDisplay ? 1 - rect.h / 2 : Math.max(0, 1 - rect.h),
		);
		const center = { x: x + rect.w / 2, y: y + rect.h / 2 };
		if (isDisplay) setProject("background", "displayPosition", center);
		else setProject("camera", "manualPosition", center);
	});

	return (
		<div class="absolute inset-0 pointer-events-none">
			<Show when={overlayVisible()}>
				<Show when={selection()}>
					<div
						class="absolute inset-0 pointer-events-auto"
						onMouseDown={(e) => {
							if (e.button !== 0) return;
							setEditorState("canvasSelection", null);
						}}
					/>
				</Show>
				<Show when={showDisplay() && displayRect()}>
					{(rect) => (
						<ElementBox
							size={props.size}
							rect={rect()}
							label="Screen"
							selected={selection()?.type === "display"}
							draggable={displayDraggable()}
							resizable={displayDraggable()}
							locked={
								displayDraggable()
									? null
									: {
											message: "Screen is locked while a zoom is active",
											actionLabel: "Edit zoom",
											onAction: selectActiveZoom,
										}
							}
							onMouseDown={(e) => {
								if (e.button !== 0) return;
								if (selection()?.type !== "display") select("display");
								onDisplayMove(e);
							}}
							resizeHandler={displayResizeHandler}
						/>
					)}
				</Show>
				<Show when={showCamera() && cameraRect()}>
					{(rect) => (
						<ElementBox
							size={props.size}
							rect={rect()}
							label="Camera"
							selected={selection()?.type === "camera"}
							draggable
							resizable={cameraResizable()}
							locked={
								cameraResizable()
									? null
									: {
											message: "Camera size follows the zoom — drag to move",
											actionLabel: "Edit zoom",
											onAction: selectActiveZoom,
										}
							}
							onMouseDown={(e) => {
								if (e.button !== 0) return;
								if (selection()?.type !== "camera") select("camera");
								onCameraMove(e);
							}}
							resizeHandler={cameraResizeHandler}
						/>
					)}
				</Show>
			</Show>
		</div>
	);
}

function ElementBox(props: {
	size: Size;
	rect: NormRect;
	label: string;
	selected: boolean;
	draggable: boolean;
	resizable: boolean;
	locked?: {
		message: string;
		actionLabel: string;
		onAction: () => void;
	} | null;
	onMouseDown: (e: MouseEvent) => void;
	resizeHandler: (dirX: 1 | -1, dirY: 1 | -1) => (e: MouseEvent) => void;
}) {
	// The letterbox wrapper has `contain: strict`, so anything positioned
	// outside the canvas is clipped — keep the label and the corner handles
	// inside the visible area when the box touches (or overhangs) an edge.
	const labelStyle = () => {
		const leftPx = props.rect.x * props.size.width;
		const topPx = props.rect.y * props.size.height;
		return {
			left: `${Math.max(6, 6 - leftPx)}px`,
			top: topPx >= 28 ? "-24px" : `${Math.max(6, 6 - topPx)}px`,
		};
	};

	// The lock banner pins to the top-center of the CANVAS, not the box: small
	// boxes (camera) can't fit the text, and edge-hugging boxes would push it
	// into the letterbox clip. Coordinates convert canvas space to box-local
	// space. Reaching it from a small box means leaving the box, so it also
	// shows while the element is selected — attempting to drag/resize selects,
	// which pins the banner until the user clicks elsewhere.
	const lockedBannerStyle = () => ({
		left: `${props.size.width / 2 - props.rect.x * props.size.width}px`,
		top: `${10 - props.rect.y * props.size.height}px`,
	});

	const flush = () => ({
		left: props.rect.x * props.size.width <= 6,
		top: props.rect.y * props.size.height <= 6,
		right:
			(props.rect.x + props.rect.w) * props.size.width >= props.size.width - 6,
		bottom:
			(props.rect.y + props.rect.h) * props.size.height >=
			props.size.height - 6,
	});

	const corners = () => {
		const f = flush();
		return [
			{
				dirX: -1 as const,
				dirY: -1 as const,
				cursor: "cursor-nw-resize",
				class: cx(
					"top-0 left-0",
					!f.left && "-translate-x-1/2",
					!f.top && "-translate-y-1/2",
				),
			},
			{
				dirX: 1 as const,
				dirY: -1 as const,
				cursor: "cursor-ne-resize",
				class: cx(
					"top-0 right-0",
					!f.right && "translate-x-1/2",
					!f.top && "-translate-y-1/2",
				),
			},
			{
				dirX: -1 as const,
				dirY: 1 as const,
				cursor: "cursor-sw-resize",
				class: cx(
					"bottom-0 left-0",
					!f.left && "-translate-x-1/2",
					!f.bottom && "translate-y-1/2",
				),
			},
			{
				dirX: 1 as const,
				dirY: 1 as const,
				cursor: "cursor-se-resize",
				class: cx(
					"bottom-0 right-0",
					!f.right && "translate-x-1/2",
					!f.bottom && "translate-y-1/2",
				),
			},
		];
	};

	// Hover is tracked in state rather than CSS group-hover so the handles
	// reveal deterministically (and survive partial HMR of provider modules).
	const [hovered, setHovered] = createSignal(false);
	const showHandles = () => props.selected || hovered();

	return (
		<div
			class="absolute pointer-events-auto"
			style={{
				left: `${props.rect.x * props.size.width}px`,
				top: `${props.rect.y * props.size.height}px`,
				width: `${props.rect.w * props.size.width}px`,
				height: `${props.rect.h * props.size.height}px`,
			}}
			onMouseDown={props.onMouseDown}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
		>
			<div
				class="absolute inset-0 border-2 transition-colors rounded-md"
				classList={{
					"border-blue-9": props.selected,
					"border-blue-6": !props.selected && hovered(),
					"border-transparent": !props.selected && !hovered(),
					"cursor-move": props.draggable,
					"cursor-default": !props.draggable,
				}}
			/>
			<Show when={props.selected || hovered()}>
				<div
					class="absolute flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-medium text-white bg-blue-9 rounded pointer-events-none select-none"
					style={labelStyle()}
				>
					{props.label}
					<Show when={props.locked}>
						<IconLucideLock class="size-2.5" />
					</Show>
				</div>
			</Show>
			<Show when={props.selected || hovered() ? props.locked : null}>
				{(locked) => (
					<div
						class="absolute z-10 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-lg bg-black/80 py-1.5 pr-1.5 pl-3 text-xs text-white shadow-md pointer-events-auto select-none"
						style={lockedBannerStyle()}
						onMouseDown={(e) => e.stopPropagation()}
					>
						<IconLucideLock class="size-3 shrink-0 opacity-80" />
						<span>{locked().message}</span>
						<button
							type="button"
							class="rounded-md bg-white/15 px-2 py-0.5 font-semibold transition-colors hover:bg-white/25 active:bg-white/30"
							onClick={locked().onAction}
						>
							{locked().actionLabel}
						</button>
					</div>
				)}
			</Show>
			<Show when={showHandles()}>
				<For each={corners()}>
					{(corner) => (
						// The hit target must not change size on hover — the grow
						// effect lives on an inner, pointer-events-none span,
						// otherwise the handle scales out from under the cursor and
						// hover flickers in a mouseenter/leave loop.
						<div
							class={cx(
								"absolute w-3 h-3 group/handle",
								props.resizable ? corner.cursor : "cursor-not-allowed",
								corner.class,
							)}
							onMouseDown={(e) => {
								if (!props.resizable) {
									e.preventDefault();
									e.stopPropagation();
									return;
								}
								props.resizeHandler(corner.dirX, corner.dirY)(e);
							}}
						>
							<span
								class={cx(
									"block size-full rounded-full border border-white shadow-xs pointer-events-none",
									props.resizable
										? "bg-blue-9 transition-transform group-hover/handle:scale-125"
										: "bg-gray-8 opacity-60",
								)}
							/>
						</div>
					)}
				</For>
			</Show>
		</div>
	);
}
