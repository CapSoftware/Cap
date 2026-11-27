import {
	createEventListener,
	createEventListenerMap,
} from "@solid-primitives/event-listener";
import { throttle } from "@solid-primitives/scheduled";
import { cx } from "cva";
import {
	createEffect,
	createMemo,
	createRoot,
	createSignal,
	For,
	on,
	onCleanup,
	Show,
} from "solid-js";
import { produce } from "solid-js/store";
import type { TextSegment as TauriTextSegment } from "../../../engine/types";
import { useCanvasSnapTargets } from "./CanvasElementsOverlay";
import { FPS, useEditorContext } from "./context";
import { arrowStep, type DragPoint, runSteppedDrag } from "./keyboard-steps";
import { createOverlaySegments } from "./overlay-segments";
import { SNAP_PX, snapMovingRect } from "./snapping";
import {
	TEXT_FONT_SIZE_MAX,
	TEXT_FONT_SIZE_MIN,
	TEXT_REFERENCE_HEIGHT,
	type TextAlign,
	type TextSegment,
} from "./text";
import { getOverlayZIndex } from "./timelineTracks";

type TextOverlayProps = {
	size: { width: number; height: number };
};

const clamp = (value: number, min: number, max: number) =>
	min > max ? (min + max) / 2 : Math.min(Math.max(value, min), max);

type TextDrag = {
	onMouseDown: (downEvent: MouseEvent) => void;
	onKeyDown: (event: KeyboardEvent) => void;
};

type CreateTextDrag = <T extends { moved: boolean }>(
	setup: () => T | null,
	update: (
		e: DragPoint,
		value: T,
		initialMouse: { x: number; y: number },
		isFinal: boolean,
	) => void,
	onFinish?: () => void,
) => TextDrag;

export function TextOverlay(props: TextOverlayProps) {
	const {
		project,
		setProject,
		editorState,
		setEditorState,
		projectHistory,
		setSnapGuides,
	} = useEditorContext();

	const currentAbsoluteTime = () =>
		editorState.previewTime ?? editorState.playbackTime ?? 0;

	const { visible: visibleTextSegments } = createOverlaySegments(
		() => project.timeline?.textSegments ?? [],
		currentAbsoluteTime,
	);

	const selectedTextIndex = createMemo(() => {
		const selection = editorState.timeline.selection;
		if (!selection || selection.type !== "text") return null;
		return selection.indices[0] ?? null;
	});

	const updateSegmentByIndex = (
		index: number,
		fn: (segment: TextSegment) => void,
	) => {
		setProject(
			"timeline",
			"textSegments",
			index,
			produce((segment) => {
				if (!segment) return;
				fn(segment);
			}),
		);
	};

	const createMouseDownDrag: CreateTextDrag = <T extends { moved: boolean }>(
		setup: () => T | null,
		update: (
			e: DragPoint,
			value: T,
			initialMouse: { x: number; y: number },
			isFinal: boolean,
		) => void,
		onFinish?: () => void,
	): TextDrag => {
		const onKeyDown = (event: KeyboardEvent) => {
			const step = arrowStep(event);
			if (!step) return;
			event.preventDefault();
			const stepped = runSteppedDrag(
				step,
				setup,
				(point, state, origin) => {
					state.moved = true;
					update(point, state, origin, true);
				},
				projectHistory.pause,
			);
			if (!stepped) return;
			setSnapGuides([]);
			onFinish?.();
		};
		const onMouseDown = (downEvent: MouseEvent) => {
			if (downEvent.button !== 0) return;
			const initial = setup();
			if (!initial) return;
			const state = initial;

			downEvent.preventDefault();
			downEvent.stopPropagation();

			const initialMouse = { x: downEvent.clientX, y: downEvent.clientY };
			const resumeHistory = projectHistory.pause();

			function handleUpdate(event: MouseEvent, isFinal: boolean) {
				// A plain click (e.g. the first half of a double-click) must not
				// write config.
				if (
					!state.moved &&
					Math.hypot(
						event.clientX - initialMouse.x,
						event.clientY - initialMouse.y,
					) < 2
				)
					return;
				state.moved = true;
				update(event, state, initialMouse, isFinal);
			}

			let pendingEvent: MouseEvent | null = null;
			let rafId: number | undefined;
			function scheduleUpdate(event: MouseEvent) {
				pendingEvent = event;
				if (rafId !== undefined) return;
				rafId = requestAnimationFrame(() => {
					rafId = undefined;
					const next = pendingEvent;
					pendingEvent = null;
					if (next) handleUpdate(next, false);
				});
			}

			function finish(finalEvent: MouseEvent) {
				if (rafId !== undefined) cancelAnimationFrame(rafId);
				rafId = undefined;
				pendingEvent = null;
				handleUpdate(finalEvent, true);
				resumeHistory();
				setSnapGuides([]);
				onFinish?.();
				dispose();
			}

			const dispose = createRoot((dispose) => {
				createEventListenerMap(window, {
					mousemove: scheduleUpdate,
					mouseup: finish,
				});
				return dispose;
			});
		};
		return { onMouseDown, onKeyDown };
	};

	const handleSelectSegment = (index: number) => {
		setEditorState("timeline", "selection", {
			type: "text",
			indices: [index],
		});
	};

	createEffect(() => {
		const pending = editorState.timeline.pendingTextEdit;
		if (pending === null) return;
		if (selectedTextIndex() !== pending) {
			setEditorState("timeline", "pendingTextEdit", null);
		}
	});

	createEventListener(document, "keydown", (e: KeyboardEvent) => {
		const index = selectedTextIndex();
		if (index === null) return;
		if (!visibleTextSegments().some((v) => v.index === index)) return;
		const target = e.target as HTMLElement | null;
		if (
			target &&
			(target.tagName === "INPUT" ||
				target.tagName === "TEXTAREA" ||
				target.isContentEditable)
		)
			return;

		if (e.key === "Escape") {
			setEditorState("timeline", "selection", null);
			return;
		}

		const arrows: Record<string, [number, number]> = {
			ArrowLeft: [-1, 0],
			ArrowRight: [1, 0],
			ArrowUp: [0, -1],
			ArrowDown: [0, 1],
		};
		const dir = arrows[e.key];
		if (!dir || e.defaultPrevented) return;

		e.preventDefault();
		const px = e.shiftKey ? 10 : 1;
		updateSegmentByIndex(index, (s) => {
			s.center.x = clamp(
				s.center.x + (dir[0] * px) / props.size.width,
				s.size.x / 2,
				1 - s.size.x / 2,
			);
			s.center.y = clamp(
				s.center.y + (dir[1] * px) / props.size.height,
				s.size.y / 2,
				1 - s.size.y / 2,
			);
		});
	});

	return (
		<div class="absolute inset-0 pointer-events-none">
			<For each={visibleTextSegments()}>
				{({ segment, index }) => (
					<TextSegmentOverlay
						size={props.size}
						segment={segment}
						index={index}
						zIndex={getOverlayZIndex(project, "text", segment.track ?? 0)}
						isSelected={selectedTextIndex() === index}
						onSelect={() => handleSelectSegment(index)}
						updateSegment={(fn) => updateSegmentByIndex(index, fn)}
						createMouseDownDrag={createMouseDownDrag}
					/>
				)}
			</For>
		</div>
	);
}

type SegmentWithDefaults = {
	start: number;
	end: number;
	enabled: boolean;
	content: string;
	center: { x: number; y: number };
	size: { x: number; y: number };
	fontFamily: string;
	fontSize: number;
	fontWeight: number;
	italic: boolean;
	uppercase: boolean;
	color: string;
	backgroundColor: string | null;
	align: TextAlign;
	letterSpacing: number;
	lineHeight: number;
};

function normalizeSegment(segment: TauriTextSegment): SegmentWithDefaults {
	// The generated bindings lag behind the Rust schema until the next debug
	// run regenerates them; the style fields are always present at runtime.
	const styled = segment as TauriTextSegment &
		Partial<
			Pick<
				TextSegment,
				| "align"
				| "backgroundColor"
				| "letterSpacing"
				| "lineHeight"
				| "uppercase"
			>
		>;
	return {
		start: segment.start,
		end: segment.end,
		enabled: segment.enabled ?? true,
		content: segment.content ?? "Text",
		center: segment.center ?? { x: 0.5, y: 0.5 },
		size: segment.size ?? { x: 0.35, y: 0.2 },
		fontFamily: segment.fontFamily ?? "sans-serif",
		fontSize: segment.fontSize ?? 48,
		fontWeight: segment.fontWeight ?? 700,
		italic: segment.italic ?? false,
		uppercase: styled.uppercase ?? false,
		color: segment.color ?? "#ffffff",
		backgroundColor: styled.backgroundColor ?? null,
		align: styled.align ?? "center",
		letterSpacing: styled.letterSpacing ?? 0,
		lineHeight: styled.lineHeight ?? 1.2,
	};
}

// Extra normalized width the stored box gets over the measured ink, so small
// font-metric differences between the browser and the renderer's shaper
// (cosmic-text) can't cause a surprise line wrap.
const WIDTH_SLACK_PX = 2;

function TextSegmentOverlay(props: {
	size: { width: number; height: number };
	segment: TauriTextSegment;
	index: number;
	zIndex: number;
	isSelected: boolean;
	onSelect: () => void;
	updateSegment: (fn: (segment: TextSegment) => void) => void;
	createMouseDownDrag: CreateTextDrag;
}) {
	const segment = createMemo(() => normalizeSegment(props.segment));
	const {
		setProject,
		setSnapGuides,
		projectHistory,
		projectActions,
		editorState,
		setEditorState,
	} = useEditorContext();
	const snapTargetsFor = useCanvasSnapTargets();

	let measureRef: HTMLDivElement | undefined;
	let textareaRef: HTMLTextAreaElement | undefined;
	const [resizing, setResizing] = createSignal(false);
	const [hovered, setHovered] = createSignal(false);
	const [editing, setEditing] = createSignal(false);

	const [dragOverride, setDragOverride] = createSignal<{
		center: { x: number; y: number };
		size: { x: number; y: number };
		fontSize: number;
	} | null>(null);

	const view = () => {
		const override = dragOverride();
		if (override) return override;
		const seg = segment();
		return { center: seg.center, size: seg.size, fontSize: seg.fontSize };
	};

	const fontPx = () =>
		(segment().fontSize * props.size.height) / TEXT_REFERENCE_HEIGHT;

	const measureInk = () => {
		if (!measureRef || !props.size.width || !props.size.height) return null;
		const { width, height } = measureRef.getBoundingClientRect();
		if (width === 0 || height === 0) return null;
		return {
			x: Math.min((width + WIDTH_SLACK_PX) / props.size.width, 1),
			y: height / props.size.height,
		};
	};

	// Fit the stored box to the measured text. The box adapts to the glyphs,
	// never the other way around: the top edge stays fixed (the renderer
	// anchors text at the top of the box) and the horizontal edge the text is
	// aligned to stays pinned — center for centered text, left/right edge for
	// left/right-aligned — so a hug never moves pixels on screen.
	const applyHug = () => {
		const ink = measureInk();
		if (!ink) return;
		const seg = segment();
		const epsX = 0.5 / props.size.width;
		const epsY = 0.5 / props.size.height;
		if (
			Math.abs(ink.x - seg.size.x) < epsX &&
			Math.abs(ink.y - seg.size.y) < epsY
		)
			return;
		const align = seg.align;
		props.updateSegment((s) => {
			const topEdge = s.center.y - s.size.y / 2;
			if (align === "left") {
				const leftEdge = s.center.x - s.size.x / 2;
				s.center.x = leftEdge + ink.x / 2;
			} else if (align === "right") {
				const rightEdge = s.center.x + s.size.x / 2;
				s.center.x = rightEdge - ink.x / 2;
			}
			s.size.x = ink.x;
			s.size.y = ink.y;
			s.center.y = topEdge + ink.y / 2;
		});
	};

	createEffect(
		on(
			() => ({
				content: segment().content,
				fontPx: fontPx(),
				fontWeight: segment().fontWeight,
				fontFamily: segment().fontFamily,
				italic: segment().italic,
				align: segment().align,
				letterSpacing: segment().letterSpacing,
				lineHeight: segment().lineHeight,
				width: props.size.width,
				height: props.size.height,
			}),
			() => {
				if (resizing()) return;
				applyHug();
				// Re-check on the next frame: right after mount (or a font swap)
				// the first layout pass can measure before the final metrics.
				const raf = requestAnimationFrame(() => {
					if (!resizing()) applyHug();
				});
				onCleanup(() => cancelAnimationFrame(raf));
			},
		),
	);

	const rect = () => {
		const { center, size } = view();
		const width = size.x * props.size.width;
		const height = size.y * props.size.height;
		return {
			width,
			height,
			left: center.x * props.size.width - width / 2,
			top: center.y * props.size.height - height / 2,
		};
	};

	const thresholds = () => ({
		x: SNAP_PX / Math.max(props.size.width, 1),
		y: SNAP_PX / Math.max(props.size.height, 1),
	});

	const commitCenter = (center: { x: number; y: number }) =>
		props.updateSegment((s) => {
			s.center.x = center.x;
			s.center.y = center.y;
		});

	const onMove = props.createMouseDownDrag(
		() => {
			if (editing()) return null;
			const seg = segment();
			return {
				startCenter: { ...seg.center },
				startSize: { ...seg.size },
				startFontSize: seg.fontSize,
				targets: snapTargetsFor({ text: props.index }),
				commit: throttle(commitCenter, 1000 / FPS),
				moved: false,
			};
		},
		(e, state, initialMouse, isFinal) => {
			const dx = (e.clientX - initialMouse.x) / props.size.width;
			const dy = (e.clientY - initialMouse.y) / props.size.height;
			const { startCenter, startSize } = state;

			const raw = {
				x: startCenter.x + dx - startSize.x / 2,
				y: startCenter.y + dy - startSize.y / 2,
				w: startSize.x,
				h: startSize.y,
			};

			let snapDx = 0;
			let snapDy = 0;
			if (e.shiftKey) {
				setSnapGuides([]);
			} else {
				const snap = snapMovingRect(
					raw,
					state.targets,
					thresholds().x,
					thresholds().y,
				);
				snapDx = snap.dx;
				snapDy = snap.dy;
				setSnapGuides(snap.guides);
			}

			const center = {
				x: clamp(
					startCenter.x + dx + snapDx,
					startSize.x / 2,
					1 - startSize.x / 2,
				),
				y: clamp(
					startCenter.y + dy + snapDy,
					startSize.y / 2,
					1 - startSize.y / 2,
				),
			};

			setDragOverride({
				center,
				size: startSize,
				fontSize: state.startFontSize,
			});
			if (isFinal) {
				state.commit.clear();
				commitCenter(center);
			} else {
				state.commit(center);
			}
		},
		() => setDragOverride(null),
	);

	const commitScaled = (next: {
		center: { x: number; y: number };
		size: { x: number; y: number };
		fontSize: number;
	}) =>
		props.updateSegment((s) => {
			s.fontSize = Math.round(next.fontSize * 10) / 10;
			s.size.x = next.size.x;
			s.size.y = next.size.y;
			s.center.x = next.center.x;
			s.center.y = next.center.y;
		});

	const createResizeHandler = (dirX: 1 | 0 | -1, dirY: 1 | 0 | -1) =>
		props.createMouseDownDrag(
			() => {
				if (!props.isSelected) props.onSelect();
				setResizing(true);
				const seg = segment();
				const corner = {
					x: seg.center.x + (dirX * seg.size.x) / 2,
					y: seg.center.y + (dirY * seg.size.y) / 2,
				};
				return {
					startFontSize: seg.fontSize,
					startCenter: { ...seg.center },
					startSize: { ...seg.size },
					corner,
					anchor: {
						x: seg.center.x - (dirX * seg.size.x) / 2,
						y: seg.center.y - (dirY * seg.size.y) / 2,
					},
					commit: throttle(commitScaled, 1000 / FPS),
					moved: false,
				};
			},
			(e, state, initialMouse, isFinal) => {
				const { anchor, corner, startCenter, startSize, startFontSize } = state;
				const pointer = {
					x: corner.x + (e.clientX - initialMouse.x) / props.size.width,
					y: corner.y + (e.clientY - initialMouse.y) / props.size.height,
				};
				const d = { x: corner.x - anchor.x, y: corner.y - anchor.y };
				const dLen2 = d.x * d.x + d.y * d.y;
				let scale =
					dLen2 > 0
						? ((pointer.x - anchor.x) * d.x + (pointer.y - anchor.y) * d.y) /
							dLen2
						: 1;

				// No guide snapping while scaling — a snapped corner multiplies
				// across the whole box and reads as an abrupt jump. The only
				// limits are the font range and "the box fits in the frame".
				const minScale = TEXT_FONT_SIZE_MIN / startFontSize;
				const maxScale = Math.min(
					TEXT_FONT_SIZE_MAX / startFontSize,
					1 / Math.max(startSize.x, startSize.y),
				);
				scale = clamp(scale, minScale, Math.max(maxScale, minScale));

				const size = { x: startSize.x * scale, y: startSize.y * scale };
				const center = {
					x: clamp(
						anchor.x + (startCenter.x - anchor.x) * scale,
						size.x / 2,
						1 - size.x / 2,
					),
					y: clamp(
						anchor.y + (startCenter.y - anchor.y) * scale,
						size.y / 2,
						1 - size.y / 2,
					),
				};
				const next = { fontSize: startFontSize * scale, size, center };

				setDragOverride(next);
				if (isFinal) {
					state.commit.clear();
					commitScaled(next);
				} else {
					state.commit(next);
				}
			},
			() => {
				setResizing(false);
				setDragOverride(null);
				requestAnimationFrame(() => applyHug());
			},
		);

	let endEditing: (() => void) | null = null;
	const startEditing = () => {
		if (editing()) return;
		const resumeHistory = projectHistory.pause();
		setEditing(true);
		setProject("hiddenTextSegments", [props.index]);
		queueMicrotask(() => {
			textareaRef?.focus();
			textareaRef?.select();
		});
		endEditing = () => {
			endEditing = null;
			setEditing(false);
			setProject("hiddenTextSegments", []);
			const empty = segment().content.trim() === "";
			if (empty) projectActions.deleteTextSegments([props.index]);
			resumeHistory();
		};
	};
	onCleanup(() => {
		endEditing?.();
		setResizing(false);
	});

	createEffect(() => {
		if (editorState.timeline.pendingTextEdit !== props.index) return;
		if (!props.isSelected) return;
		setEditorState("timeline", "pendingTextEdit", null);
		startEditing();
	});

	const edges = [
		{
			dirX: 0 as const,
			dirY: -1 as const,
			name: "top edge",
			class:
				"top-0 inset-x-2.5 w-[calc(100%-1.25rem)] h-2.5 -translate-y-1/2 cursor-ns-resize",
		},
		{
			dirX: 0 as const,
			dirY: 1 as const,
			name: "bottom edge",
			class:
				"bottom-0 inset-x-2.5 w-[calc(100%-1.25rem)] h-2.5 translate-y-1/2 cursor-ns-resize",
		},
		{
			dirX: -1 as const,
			dirY: 0 as const,
			name: "left edge",
			class:
				"left-0 inset-y-2.5 h-[calc(100%-1.25rem)] w-2.5 -translate-x-1/2 cursor-ew-resize",
		},
		{
			dirX: 1 as const,
			dirY: 0 as const,
			name: "right edge",
			class:
				"right-0 inset-y-2.5 h-[calc(100%-1.25rem)] w-2.5 translate-x-1/2 cursor-ew-resize",
		},
	];

	const corners = [
		{
			dirX: -1 as const,
			dirY: -1 as const,
			name: "top left corner",
			class: "top-0 left-0 -translate-x-1/2 -translate-y-1/2 cursor-nw-resize",
		},
		{
			dirX: 1 as const,
			dirY: -1 as const,
			name: "top right corner",
			class: "top-0 right-0 translate-x-1/2 -translate-y-1/2 cursor-ne-resize",
		},
		{
			dirX: -1 as const,
			dirY: 1 as const,
			name: "bottom left corner",
			class:
				"bottom-0 left-0 -translate-x-1/2 translate-y-1/2 cursor-sw-resize",
		},
		{
			dirX: 1 as const,
			dirY: 1 as const,
			name: "bottom right corner",
			class:
				"bottom-0 right-0 translate-x-1/2 translate-y-1/2 cursor-se-resize",
		},
	];

	// The letterbox wrapper has `contain: strict`, so keep the label inside
	// the visible area when the box touches the frame's top edge.
	const labelStyle = () => ({
		left: `${Math.max(6, 6 - rect().left)}px`,
		top: rect().top >= 28 ? "-24px" : `${Math.max(6, 6 - rect().top)}px`,
	});

	const letterSpacingPx = () =>
		(segment().letterSpacing * props.size.height) / TEXT_REFERENCE_HEIGHT;
	const backgroundPaddingPx = () => fontPx() * 0.2;
	const backgroundRadiusPx = () => fontPx() * 0.15;

	const textStyle = () => ({
		"font-family": segment().fontFamily,
		"font-size": `${fontPx()}px`,
		"font-weight": segment().fontWeight,
		"font-style": segment().italic ? "italic" : "normal",
		"line-height": segment().lineHeight,
		"letter-spacing": `${letterSpacingPx()}px`,
		"text-transform": segment().uppercase ? "uppercase" : "none",
	});

	return (
		<>
			<div
				ref={measureRef}
				style={{
					...textStyle(),
					position: "absolute",
					visibility: "hidden",
					"pointer-events": "none",
					"white-space": "pre-wrap",
					"word-break": "break-word",
					"max-width": `${props.size.width}px`,
					width: "fit-content",
					height: "auto",
					top: "0",
					left: "0",
				}}
			>
				{segment().content}
				{segment().content.endsWith("\n") ? <br /> : null}
			</div>

			<div
				class="absolute pointer-events-auto"
				classList={{
					"cursor-move": !editing(),
					"cursor-text": editing(),
				}}
				style={{
					"z-index": props.zIndex,
					left: `${rect().left}px`,
					top: `${rect().top}px`,
					width: `${rect().width}px`,
					height: `${rect().height}px`,
				}}
				onPointerEnter={() => setHovered(true)}
				onPointerLeave={() => setHovered(false)}
			>
				<button
					type="button"
					aria-label={`Text "${segment().content}". Arrow keys move it, with Shift in bigger steps. Enter edits it.`}
					aria-pressed={props.isSelected}
					class="peer absolute inset-0 size-full outline-hidden"
					classList={{
						"cursor-move": !editing(),
						"cursor-text": editing(),
					}}
					onMouseDown={(e) => {
						if (e.button !== 0) return;
						if (!props.isSelected) props.onSelect();
						onMove.onMouseDown(e);
					}}
					onDblClick={() => startEditing()}
					onClick={(e) => {
						if (e.detail !== 0) return;
						if (props.isSelected) startEditing();
						else props.onSelect();
					}}
					onKeyDown={(e) => {
						if (!arrowStep(e) || editing()) return;
						if (!props.isSelected) props.onSelect();
						onMove.onKeyDown(e);
					}}
				/>
				<Show when={editing() && segment().backgroundColor}>
					<div
						class="absolute pointer-events-none"
						style={{
							top: `${-backgroundPaddingPx()}px`,
							left: `${-backgroundPaddingPx()}px`,
							width: `calc(100% + ${backgroundPaddingPx() * 2}px)`,
							"min-height": `calc(100% + ${backgroundPaddingPx() * 2}px)`,
							padding: `${backgroundPaddingPx()}px`,
							"box-sizing": "border-box",
							"border-radius": `${backgroundRadiusPx()}px`,
							"background-color": segment().backgroundColor ?? "transparent",
						}}
					>
						<div
							aria-hidden="true"
							style={{
								...textStyle(),
								visibility: "hidden",
								"white-space": "pre-wrap",
								"word-break": "break-word",
								"text-align": segment().align,
							}}
						>
							{segment().content}
							{segment().content.endsWith("\n") ? <br /> : null}
						</div>
					</div>
				</Show>
				<div
					class="absolute inset-0 border-2 transition-colors rounded-md pointer-events-none peer-focus-visible:ring-2 peer-focus-visible:ring-blue-9/60"
					style={{ opacity: "var(--preview-controls-opacity, 1)" }}
					classList={{
						"border-blue-9": props.isSelected,
						"border-blue-6": !props.isSelected && hovered(),
						"border-transparent": !props.isSelected && !hovered(),
					}}
				/>
				<Show when={(props.isSelected || hovered()) && !editing()}>
					<div
						class="absolute px-1.5 py-0.5 text-[11px] font-medium text-white bg-blue-9 rounded pointer-events-none select-none"
						style={{
							...labelStyle(),
							opacity: "var(--preview-controls-opacity, 1)",
						}}
					>
						Text
					</div>
				</Show>
				<Show when={editing()}>
					<textarea
						ref={textareaRef}
						class="absolute inset-0 p-0 bg-transparent border-none outline-none resize-none overflow-hidden"
						style={{
							...textStyle(),
							"text-align": segment().align,
							color: segment().color,
							"caret-color": segment().color,
							"white-space": "pre-wrap",
							"word-break": "break-word",
						}}
						value={segment().content}
						onInput={(e) =>
							props.updateSegment((s) => {
								s.content = e.currentTarget.value;
							})
						}
						onKeyDown={(e) => {
							e.stopPropagation();
							if (e.key === "Escape") {
								e.preventDefault();
								textareaRef?.blur();
							}
						}}
						onMouseDown={(e) => e.stopPropagation()}
						onBlur={() => endEditing?.()}
					/>
				</Show>
				{/* The handles stay up while the inline editor is open (a freshly
				    added segment mounts editing), and the drag's preventDefault
				    keeps the textarea focused, so a resize never ends the edit. */}
				<Show when={props.isSelected || hovered()}>
					<For each={edges}>
						{(edge) => {
							const drag = createResizeHandler(edge.dirX, edge.dirY);
							return (
								<button
									type="button"
									aria-label={`Scale text from the ${edge.name}. Arrow keys move the edge, with Shift in bigger steps.`}
									class={cx(
										"absolute outline-hidden focus-visible:ring-2 focus-visible:ring-blue-9/60",
										edge.class,
									)}
									onMouseDown={drag.onMouseDown}
									onKeyDown={drag.onKeyDown}
								/>
							);
						}}
					</For>
					<For each={corners}>
						{(corner) => {
							const drag = createResizeHandler(corner.dirX, corner.dirY);
							return (
								// The hit target is larger than the visible dot (text boxes
								// hug the glyphs, so corners are small targets), and must
								// not change size on hover — the grow effect lives on an
								// inner, pointer-events-none span, otherwise the handle
								// scales out from under the cursor and hover flickers in a
								// mouseenter/leave loop.
								<button
									type="button"
									aria-label={`Scale text from the ${corner.name}. Arrow keys move the corner, with Shift in bigger steps.`}
									class={cx(
										"absolute w-5 h-5 grid place-items-center group/handle outline-hidden",
										corner.class,
									)}
									onMouseDown={drag.onMouseDown}
									onKeyDown={drag.onKeyDown}
								>
									<span
										class="w-3 h-3 rounded-full border border-white shadow-xs pointer-events-none bg-blue-9 transition-transform group-hover/handle:scale-125 group-focus-visible/handle:ring-2 group-focus-visible/handle:ring-blue-9/60"
										style={{ opacity: "var(--preview-controls-opacity, 1)" }}
									/>
								</button>
							);
						}}
					</For>
				</Show>
			</div>
		</>
	);
}
