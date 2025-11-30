import { createEventListenerMap } from "@solid-primitives/event-listener";
import { cx } from "cva";
import { createMemo, createRoot, Show } from "solid-js";
import { produce } from "solid-js/store";

import { useEditorContext } from "./context";
import { evaluateMask, type MaskSegment } from "./masks";

type MaskOverlayProps = {
	size: { width: number; height: number };
};

export function MaskOverlay(props: MaskOverlayProps) {
	const { project, setProject, editorState, projectHistory } =
		useEditorContext();

	const selectedMask = createMemo(() => {
		const selection = editorState.timeline.selection;
		if (!selection || selection.type !== "mask") return;
		const index = selection.indices[0];
		const segment = project.timeline?.maskSegments?.[index];
		if (!segment) return;
		return { index, segment };
	});

	const currentAbsoluteTime = () =>
		editorState.previewTime ?? editorState.playbackTime ?? 0;

	const maskState = createMemo(() => {
		const selected = selectedMask();
		if (!selected) return;
		return evaluateMask(selected.segment, currentAbsoluteTime());
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

	function createMouseDownDrag<T>(
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

			const initial = setup();
			const initialMouse = { x: downEvent.clientX, y: downEvent.clientY };
			const resumeHistory = projectHistory.pause();

			function handleUpdate(event: MouseEvent) {
				update(event, initial, initialMouse);
			}

			function finish() {
				resumeHistory();
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
	}

	return (
		<Show when={selectedMask() && maskState()}>
			{() => {
				const state = () => maskState()!;
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
					}),
					(e, { startPos }, initialMouse) => {
						const dx = (e.clientX - initialMouse.x) / props.size.width;
						const dy = (e.clientY - initialMouse.y) / props.size.height;

						updateSegment((s) => {
							s.center.x = Math.max(0, Math.min(1, startPos.x + dx));
							s.center.y = Math.max(0, Math.min(1, startPos.y + dy));
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
									const newWidth = Math.max(
										0.01,
										startSize.x + dx * dirX, // if dirX is -1 (left), dx needs to be inverted for width? No. If I move mouse left (dx negative), width should increase. So dx * dirX -> (-ve * -1) = +ve. Correct.
									);
									// If we clamp width, we need to adjust center calc?
									// Simple version:
									s.size.x = newWidth;
									s.center.x =
										startPos.x + (dx * dirX) / 2 + dx * (dirX === -1 ? 0 : 0);
									// Wait, my logic before:
									// Right (dirX=1): Width = W + dx. Center = C + dx/2.
									// Left (dirX=-1): Width = W - dx. Center = C + dx/2.
									// So Center is always C + dx/2 regardless of direction?
									// Let's re-verify.
									// Right Handle: move right (+dx). W grows (+dx). Center moves right (+dx/2). Correct.
									// Left Handle: move left (-dx). W grows (-dx i.e. +ve). Center moves left (-dx/2). Correct.
									// So yes, Center += dx/2. Width += dx * dirX.

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
					<div class="absolute inset-0 pointer-events-none">
						<div
							class="absolute pointer-events-auto group"
							style={{
								left: `${rect().left}px`,
								top: `${rect().top}px`,
								width: `${rect().width}px`,
								height: `${rect().height}px`,
							}}
							onMouseDown={onMove}
						>
							{/* Border/Highlight */}
							<div class="absolute inset-0 rounded-md border-2 border-blue-9 bg-blue-9/10 cursor-move" />

							{/* Handles */}
							{/* Corners */}
							<ResizeHandle
								class="top-0 left-0 -translate-x-1/2 -translate-y-1/2 cursor-nw-resize"
								onMouseDown={createResizeHandler(-1, -1)}
							/>
							<ResizeHandle
								class="top-0 right-0 translate-x-1/2 -translate-y-1/2 cursor-ne-resize"
								onMouseDown={createResizeHandler(1, -1)}
							/>
							<ResizeHandle
								class="bottom-0 left-0 -translate-x-1/2 translate-y-1/2 cursor-sw-resize"
								onMouseDown={createResizeHandler(-1, 1)}
							/>
							<ResizeHandle
								class="bottom-0 right-0 translate-x-1/2 translate-y-1/2 cursor-se-resize"
								onMouseDown={createResizeHandler(1, 1)}
							/>

							{/* Sides */}
							<ResizeHandle
								class="top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 cursor-n-resize"
								onMouseDown={createResizeHandler(0, -1)}
							/>
							<ResizeHandle
								class="bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 cursor-s-resize"
								onMouseDown={createResizeHandler(0, 1)}
							/>
							<ResizeHandle
								class="left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-w-resize"
								onMouseDown={createResizeHandler(-1, 0)}
							/>
							<ResizeHandle
								class="right-0 top-1/2 translate-x-1/2 -translate-y-1/2 cursor-e-resize"
								onMouseDown={createResizeHandler(1, 0)}
							/>
						</div>
					</div>
				);
			}}
		</Show>
	);
}

function ResizeHandle(props: {
	class?: string;
	onMouseDown: (e: MouseEvent) => void;
}) {
	return (
		<div
			class={cx(
				"absolute w-3 h-3 bg-blue-9 border border-white rounded-full shadow-sm transition-transform hover:scale-125",
				props.class,
			)}
			onMouseDown={props.onMouseDown}
		/>
	);
}
