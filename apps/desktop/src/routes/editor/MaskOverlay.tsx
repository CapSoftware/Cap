import { createEventListenerMap } from "@solid-primitives/event-listener";
import { cx } from "cva";
import { createMemo, createRoot, For, Show } from "solid-js";
import { produce } from "solid-js/store";

import { useEditorContext } from "./context";
import { evaluateMask, type MaskSegment } from "./masks";

type MaskOverlayProps = {
	size: { width: number; height: number };
};

export function MaskOverlay(props: MaskOverlayProps) {
	const { project, setProject, editorState, setEditorState, projectHistory } =
		useEditorContext();

	const currentAbsoluteTime = () =>
		editorState.previewTime ?? editorState.playbackTime ?? 0;

	const visibleMaskSegments = createMemo(() => {
		const segments = project.timeline?.maskSegments ?? [];
		const time = currentAbsoluteTime();
		return segments
			.map((segment, index) => ({ segment, index }))
			.filter(({ segment }) => time >= segment.start && time < segment.end);
	});

	const selectedMaskIndex = createMemo(() => {
		const selection = editorState.timeline.selection;
		if (!selection || selection.type !== "mask") return null;
		return selection.indices[0] ?? null;
	});

	const selectedMask = createMemo(() => {
		const index = selectedMaskIndex();
		if (index === null) return;
		const segment = project.timeline?.maskSegments?.[index];
		if (!segment) return;
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

	const getMaskRect = (segment: MaskSegment) => {
		const state = evaluateMask(segment, currentAbsoluteTime());
		const width = state.size.x * props.size.width;
		const height = state.size.y * props.size.height;
		const left = state.position.x * props.size.width - width / 2;
		const top = state.position.y * props.size.height - height / 2;
		return { width, height, left, top };
	};

	const handleBackgroundClick = (e: MouseEvent) => {
		if (e.target === e.currentTarget && selectedMaskIndex() !== null) {
			e.preventDefault();
			e.stopPropagation();
			setEditorState("timeline", "selection", null);
		}
	};

	const hasMaskSelection = () => selectedMaskIndex() !== null;

	return (
		<div
			class="absolute inset-0"
			classList={{ "pointer-events-none": !hasMaskSelection() }}
			onMouseDown={handleBackgroundClick}
		>
			<For each={visibleMaskSegments()}>
				{({ segment, index }) => {
					const isSelected = () => selectedMaskIndex() === index;
					const rect = () => getMaskRect(segment);
					const maskState = () => evaluateMask(segment, currentAbsoluteTime());

					return (
						<Show
							when={isSelected() && selectedMask()}
							fallback={
								<div
									class="absolute pointer-events-auto cursor-pointer rounded-md border-2 border-transparent hover:border-gray-12 hover:bg-gray-9/5 transition-colors"
									style={{
										left: `${rect().left}px`,
										top: `${rect().top}px`,
										width: `${rect().width}px`,
										height: `${rect().height}px`,
									}}
									onMouseDown={(e) => handleSelectSegment(index, e)}
								/>
							}
						>
							<MaskOverlayContent
								size={props.size}
								maskState={maskState}
								updateSegment={updateSegment}
								projectHistory={projectHistory}
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
	maskState: () => ReturnType<typeof evaluateMask>;
	updateSegment: (fn: (segment: MaskSegment) => void) => void;
	projectHistory: ReturnType<typeof useEditorContext>["projectHistory"];
}) {
	const { projectHistory, updateSegment } = props;

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
			class="absolute pointer-events-auto group"
			style={{
				left: `${rect().left}px`,
				top: `${rect().top}px`,
				width: `${rect().width}px`,
				height: `${rect().height}px`,
			}}
			onMouseDown={onMove}
		>
			<div class="absolute inset-0 rounded-md border-2 border-gray-12 bg-gray-9/10 cursor-move" />

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
	);
}

function ResizeHandle(props: {
	class?: string;
	onMouseDown: (e: MouseEvent) => void;
}) {
	return (
		<div
			class={cx(
				"absolute w-3 h-3 bg-gray-12 border border-white rounded-full shadow-sm transition-transform hover:scale-125",
				props.class,
			)}
			onMouseDown={props.onMouseDown}
		/>
	);
}
