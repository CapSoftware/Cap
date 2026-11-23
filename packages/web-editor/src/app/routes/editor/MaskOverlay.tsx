import { createEventListenerMap } from "@solid-primitives/event-listener";
import { cx } from "cva";
import { createMemo, createRoot, For, Show } from "solid-js";
import { produce } from "solid-js/store";

import { useCanvasSnapTargets } from "./CanvasElementsOverlay";
import { useEditorContext } from "./context";
import {
	arrowStep,
	type DragPoint,
	runSteppedDrag,
	type Vec,
} from "./keyboard-steps";
import { evaluateMask, type MaskSegment } from "./masks";
import { createOverlaySegments } from "./overlay-segments";
import { SNAP_PX, snapMovingRect } from "./snapping";
import { getOverlayZIndex } from "./timelineTracks";

type MaskOverlayProps = {
	size: { width: number; height: number };
};

export function MaskOverlay(props: MaskOverlayProps) {
	const { project, setProject, editorState, setEditorState, projectHistory } =
		useEditorContext();

	const currentAbsoluteTime = () =>
		editorState.previewTime ?? editorState.playbackTime ?? 0;

	const { indexed: maskSegments, visible: visibleMaskSegments } =
		createOverlaySegments(
			() => project.timeline?.maskSegments ?? [],
			currentAbsoluteTime,
		);

	const selectedMaskIndex = createMemo(() => {
		const selection = editorState.timeline.selection;
		if (!selection || selection.type !== "mask") return null;
		return selection.indices[0] ?? null;
	});

	const hoveredMaskIndex = createMemo(
		() => editorState.timeline.hoveredMaskIndex,
	);
	const hoveredMaskTime = createMemo(
		() => editorState.timeline.hoveredMaskTime,
	);

	const selectedMask = createMemo(() => {
		const index = selectedMaskIndex();
		if (index === null) return;
		const segment = project.timeline?.maskSegments?.[index];
		if (!segment) return;
		return { index, segment };
	});

	const hoveredMask = createMemo(() => {
		const index = hoveredMaskIndex();
		if (index === null) return null;
		const segment = project.timeline?.maskSegments?.[index];
		if (!segment) return null;
		return { index, segment };
	});

	const updateSegment = (fn: (segment: MaskSegment) => void) => {
		const index = selectedMask()?.index;
		if (index === undefined) return;
		setProject(
			"timeline",
			"maskSegments",
			index,
			produce((segment) => {
				segment.keyframes ??= { position: [], size: [], intensity: [] };
				segment.keyframes.position = [];
				segment.keyframes.size = [];
				fn(segment);
			}),
		);
	};

	const handleSelectSegment = (index: number, e: MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setEditorState("timeline", "selection", {
			type: "mask",
			indices: [index],
		});
	};

	let focusSelectedMask = false;
	const handleKeyboardSelect = (index: number, e: MouseEvent) => {
		if (e.detail !== 0) return;
		focusSelectedMask = true;
		setEditorState("timeline", "selection", {
			type: "mask",
			indices: [index],
		});
	};
	const takeSelectedMaskFocus = () => {
		const focus = focusSelectedMask;
		focusSelectedMask = false;
		return focus;
	};

	const displayedMaskSegments = createMemo(() => {
		const visible = visibleMaskSegments();
		const hoveredIndex = hoveredMaskIndex();
		if (
			hoveredIndex === null ||
			visible.some(({ index }) => index === hoveredIndex)
		) {
			return visible;
		}
		const hovered = maskSegments()[hoveredIndex];
		if (!hovered) return visible;
		return [...visible, hovered];
	});

	const getMaskTime = (index: number) => {
		const time = hoveredMaskTime();
		return hoveredMaskIndex() === index && time !== null
			? time
			: currentAbsoluteTime();
	};

	const getMaskRectAtTime = (segment: MaskSegment, time: number) => {
		const state = evaluateMask(segment, time);
		const width = state.size.x * props.size.width;
		const height = state.size.y * props.size.height;
		const left = state.position.x * props.size.width - width / 2;
		const top = state.position.y * props.size.height - height / 2;
		return { width, height, left, top };
	};

	const shouldRenderHoveredMask = () => {
		const hovered = hoveredMask();
		return (
			hovered !== null &&
			selectedMaskIndex() !== hovered.index &&
			hoveredMaskTime() !== null
		);
	};

	return (
		<div
			class="absolute inset-0 pointer-events-none"
			style={{ opacity: "var(--preview-controls-opacity, 1)" }}
		>
			<Show when={shouldRenderHoveredMask() ? hoveredMask() : null}>
				{(hovered) => {
					const rect = () =>
						getMaskRectAtTime(hovered().segment, getMaskTime(hovered().index));
					return (
						<div
							class="absolute z-20 pointer-events-none rounded-md border-2 border-gray-11/65 shadow-[0_0_0_1px_rgba(255,255,255,0.03)]"
							style={{
								"z-index": getOverlayZIndex(
									project,
									"mask",
									hovered().segment.track ?? 0,
								),
								left: `${rect().left}px`,
								top: `${rect().top}px`,
								width: `${rect().width}px`,
								height: `${rect().height}px`,
							}}
						/>
					);
				}}
			</Show>
			<For each={displayedMaskSegments()}>
				{({ segment, index }) => {
					const isSelected = () => selectedMaskIndex() === index;
					const isHovered = () => hoveredMaskIndex() === index;
					const rect = () => getMaskRectAtTime(segment, getMaskTime(index));
					const maskState = () => evaluateMask(segment, getMaskTime(index));
					const overlayClass = () =>
						cx(
							"border-transparent bg-transparent hover:border-gray-11/65",
							isHovered() && "border-gray-11/65",
						);

					return (
						<Show
							when={isSelected() && selectedMask()}
							fallback={
								<button
									type="button"
									aria-label={`Select mask ${index + 1}`}
									class={cx(
										"absolute pointer-events-auto rounded-md border-2 transition-colors outline-hidden focus-visible:border-blue-9",
										overlayClass(),
									)}
									style={{
										"z-index": getOverlayZIndex(
											project,
											"mask",
											segment.track ?? 0,
										),
										left: `${rect().left}px`,
										top: `${rect().top}px`,
										width: `${rect().width}px`,
										height: `${rect().height}px`,
									}}
									onMouseDown={(e) => handleSelectSegment(index, e)}
									onClick={(e) => handleKeyboardSelect(index, e)}
								/>
							}
						>
							<MaskOverlayContent
								size={props.size}
								maskIndex={index}
								zIndex={getOverlayZIndex(project, "mask", segment.track ?? 0)}
								maskState={maskState}
								updateSegment={updateSegment}
								projectHistory={projectHistory}
								takeFocus={takeSelectedMaskFocus}
							/>
						</Show>
					);
				}}
			</For>
		</div>
	);
}

function MaskOverlayContent(props: {
	size: { width: number; height: number };
	maskIndex: number;
	zIndex: number;
	maskState: () => ReturnType<typeof evaluateMask>;
	updateSegment: (fn: (segment: MaskSegment) => void) => void;
	projectHistory: ReturnType<typeof useEditorContext>["projectHistory"];
	takeFocus: () => boolean;
}) {
	const { projectHistory, updateSegment } = props;
	const { setSnapGuides } = useEditorContext();
	const snapTargetsFor = useCanvasSnapTargets();

	function createMouseDownDrag<T>(
		setup: () => T,
		update: (
			e: DragPoint,
			value: T,
			initialMouse: { x: number; y: number },
		) => void,
	) {
		const onKeyDown = (e: KeyboardEvent) => {
			const step = arrowStep(e);
			if (!step) return;
			e.preventDefault();
			e.stopPropagation();
			runStep(step);
		};
		const runStep = (step: Vec) => {
			runSteppedDrag(step, setup, update, projectHistory.pause);
			setSnapGuides([]);
		};
		const onMouseDown = (downEvent: MouseEvent) => {
			downEvent.preventDefault();
			downEvent.stopPropagation();

			const initial = setup();
			const initialMouse = { x: downEvent.clientX, y: downEvent.clientY };
			const resumeHistory = projectHistory.pause();

			function handleUpdate(event: MouseEvent) {
				update(event, initial, initialMouse);
			}

			function finish() {
				resumeHistory();
				setSnapGuides([]);
				dispose();
			}

			const dispose = createRoot((dispose) => {
				createEventListenerMap(window, {
					mousemove: handleUpdate,
					mouseup: () => {
						finish();
					},
				});
				return dispose;
			});
		};
		return { onMouseDown, onKeyDown };
	}

	const state = () => props.maskState();
	const rect = () => {
		const width = state().size.x * props.size.width;
		const height = state().size.y * props.size.height;
		const left = state().position.x * props.size.width - width / 2;
		const top = state().position.y * props.size.height - height / 2;
		return { width, height, left, top };
	};

	const onMove = createMouseDownDrag(
		() => ({
			startPos: { ...state().position },
			startSize: { ...state().size },
			targets: snapTargetsFor({ mask: props.maskIndex }),
		}),
		(e, { startPos, startSize, targets }, initialMouse) => {
			const dx = (e.clientX - initialMouse.x) / props.size.width;
			const dy = (e.clientY - initialMouse.y) / props.size.height;

			let snapDx = 0;
			let snapDy = 0;
			if (e.shiftKey) {
				setSnapGuides([]);
			} else {
				const snap = snapMovingRect(
					{
						x: startPos.x + dx - startSize.x / 2,
						y: startPos.y + dy - startSize.y / 2,
						w: startSize.x,
						h: startSize.y,
					},
					targets,
					SNAP_PX / props.size.width,
					SNAP_PX / props.size.height,
				);
				snapDx = snap.dx;
				snapDy = snap.dy;
				setSnapGuides(snap.guides);
			}

			updateSegment((s) => {
				s.center.x = Math.max(0, Math.min(1, startPos.x + dx + snapDx));
				s.center.y = Math.max(0, Math.min(1, startPos.y + dy + snapDy));
			});
		},
	);

	const createResizeHandler = (dirX: -1 | 0 | 1, dirY: -1 | 0 | 1) => {
		return createMouseDownDrag(
			() => ({
				startPos: { ...state().position },
				startSize: { ...state().size },
			}),
			(e, { startPos, startSize }, initialMouse) => {
				const dx = (e.clientX - initialMouse.x) / props.size.width;
				const dy = (e.clientY - initialMouse.y) / props.size.height;

				updateSegment((s) => {
					if (dirX !== 0) {
						const newWidth = Math.max(0.01, startSize.x + dx * dirX);
						s.size.x = newWidth;
						s.center.x = startPos.x + dx / 2;
					}

					if (dirY !== 0) {
						const newHeight = Math.max(0.01, startSize.y + dy * dirY);
						s.size.y = newHeight;
						s.center.y = startPos.y + dy / 2;
					}
				});
			},
		);
	};

	return (
		<div
			class="absolute pointer-events-none group z-10"
			style={{
				"z-index": props.zIndex,
				left: `${rect().left}px`,
				top: `${rect().top}px`,
				width: `${rect().width}px`,
				height: `${rect().height}px`,
			}}
		>
			<button
				type="button"
				aria-label="Mask. Arrow keys move it, with Shift in bigger steps."
				class="peer absolute inset-0 size-full pointer-events-auto cursor-move outline-hidden"
				ref={(el) => {
					if (props.takeFocus()) queueMicrotask(() => el.focus());
				}}
				onMouseDown={onMove.onMouseDown}
				onKeyDown={onMove.onKeyDown}
			/>
			<div class="absolute inset-0 rounded-md border-2 border-gray-12 pointer-events-none peer-focus-visible:ring-2 peer-focus-visible:ring-blue-9/60" />

			<For each={MASK_HANDLES}>
				{(handle) => (
					<ResizeHandle
						class={handle.class}
						label={`Resize mask from the ${handle.name}`}
						drag={createResizeHandler(handle.dirX, handle.dirY)}
					/>
				)}
			</For>
		</div>
	);
}

const MASK_HANDLES = [
	{
		dirX: -1,
		dirY: -1,
		name: "top left corner",
		class: "top-0 left-0 -translate-x-1/2 -translate-y-1/2 cursor-nw-resize",
	},
	{
		dirX: 1,
		dirY: -1,
		name: "top right corner",
		class: "top-0 right-0 translate-x-1/2 -translate-y-1/2 cursor-ne-resize",
	},
	{
		dirX: -1,
		dirY: 1,
		name: "bottom left corner",
		class: "bottom-0 left-0 -translate-x-1/2 translate-y-1/2 cursor-sw-resize",
	},
	{
		dirX: 1,
		dirY: 1,
		name: "bottom right corner",
		class: "bottom-0 right-0 translate-x-1/2 translate-y-1/2 cursor-se-resize",
	},
	{
		dirX: 0,
		dirY: -1,
		name: "top edge",
		class: "top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 cursor-n-resize",
	},
	{
		dirX: 0,
		dirY: 1,
		name: "bottom edge",
		class: "bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 cursor-s-resize",
	},
	{
		dirX: -1,
		dirY: 0,
		name: "left edge",
		class: "left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-w-resize",
	},
	{
		dirX: 1,
		dirY: 0,
		name: "right edge",
		class: "right-0 top-1/2 translate-x-1/2 -translate-y-1/2 cursor-e-resize",
	},
] as const;

function ResizeHandle(props: {
	class?: string;
	label: string;
	drag: {
		onMouseDown: (e: MouseEvent) => void;
		onKeyDown: (e: KeyboardEvent) => void;
	};
}) {
	return (
		<button
			type="button"
			aria-label={`${props.label}. Arrow keys move it, with Shift in bigger steps.`}
			class={cx(
				"absolute w-3 h-3 bg-gray-12 border border-white rounded-full shadow-xs transition-transform hover:scale-125 pointer-events-auto outline-hidden focus-visible:ring-2 focus-visible:ring-blue-9/60",
				props.class,
			)}
			onMouseDown={props.drag.onMouseDown}
			onKeyDown={props.drag.onKeyDown}
		/>
	);
}
