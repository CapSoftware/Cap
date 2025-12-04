import { cx } from "cva";
import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import IconLucideArrowUpRight from "~icons/lucide/arrow-up-right";
import IconLucideCircle from "~icons/lucide/circle";
import IconLucideEyeOff from "~icons/lucide/eye-off";
import IconLucideGripVertical from "~icons/lucide/grip-vertical";
import IconLucideLayers from "~icons/lucide/layers";
import IconLucideSquare from "~icons/lucide/square";
import IconLucideType from "~icons/lucide/type";
import IconLucideX from "~icons/lucide/x";
import { type Annotation, useScreenshotEditorContext } from "./context";

const ANNOTATION_TYPE_ICONS = {
	arrow: IconLucideArrowUpRight,
	rectangle: IconLucideSquare,
	circle: IconLucideCircle,
	mask: IconLucideEyeOff,
	text: IconLucideType,
};

const ANNOTATION_TYPE_LABELS = {
	arrow: "Arrow",
	rectangle: "Rectangle",
	circle: "Circle",
	mask: "Mask",
	text: "Text",
};

export function LayersPanel() {
	const {
		annotations,
		setAnnotations,
		selectedAnnotationId,
		setSelectedAnnotationId,
		setLayersPanelOpen,
		projectHistory,
		setActiveTool,
		setFocusAnnotationId,
	} = useScreenshotEditorContext();

	const [dragState, setDragState] = createSignal<{
		draggedId: string;
		startY: number;
		currentY: number;
	} | null>(null);

	const [dropTargetIndex, setDropTargetIndex] = createSignal<number | null>(
		null,
	);

	const getTypeLabel = (ann: Annotation) => {
		if (ann.type === "text" && ann.text) {
			const truncated =
				ann.text.length > 12 ? `${ann.text.slice(0, 12)}...` : ann.text;
			return truncated;
		}
		return ANNOTATION_TYPE_LABELS[ann.type];
	};

	const reversedAnnotations = () => [...annotations].reverse();

	const getActualIndex = (reversedIdx: number) =>
		annotations.length - 1 - reversedIdx;

	const handleDragMove = (moveEvent: MouseEvent) => {
		setDragState((prev) =>
			prev ? { ...prev, currentY: moveEvent.clientY } : null,
		);

		const listEl = document.querySelector("[data-layers-list]");
		if (!listEl) return;

		const items = listEl.querySelectorAll("[data-layer-item]");
		let targetIdx: number | null = null;

		for (let i = 0; i < items.length; i++) {
			const item = items[i] as HTMLElement;
			const rect = item.getBoundingClientRect();
			const midY = rect.top + rect.height / 2;

			if (moveEvent.clientY < midY) {
				targetIdx = i;
				break;
			}
			targetIdx = i + 1;
		}

		setDropTargetIndex(targetIdx);
	};

	const finalizeDrag = () => {
		const state = dragState();
		const targetIdx = dropTargetIndex();

		if (state && targetIdx !== null) {
			const draggedReversedIdx = reversedAnnotations().findIndex(
				(a) => a.id === state.draggedId,
			);

			if (draggedReversedIdx !== -1 && draggedReversedIdx !== targetIdx) {
				const fromActual = getActualIndex(draggedReversedIdx);
				let toActual: number;

				if (targetIdx > draggedReversedIdx) {
					toActual = getActualIndex(targetIdx - 1);
				} else {
					toActual = getActualIndex(targetIdx);
				}

				if (fromActual !== toActual) {
					projectHistory.push();
					const newAnnotations = [...annotations];
					const [removed] = newAnnotations.splice(fromActual, 1);
					newAnnotations.splice(toActual, 0, removed);
					setAnnotations(newAnnotations);
				}
			}
		}

		setDragState(null);
		setDropTargetIndex(null);
	};

	const handleDragEnd = () => {
		finalizeDrag();
	};

	const handleWindowBlur = () => {
		finalizeDrag();
	};

	const handleMouseLeave = () => {
		finalizeDrag();
	};

	createEffect(() => {
		const state = dragState();

		if (state) {
			window.addEventListener("mousemove", handleDragMove);
			window.addEventListener("mouseup", handleDragEnd);
			window.addEventListener("blur", handleWindowBlur);
			document.documentElement.addEventListener("mouseleave", handleMouseLeave);

			onCleanup(() => {
				window.removeEventListener("mousemove", handleDragMove);
				window.removeEventListener("mouseup", handleDragEnd);
				window.removeEventListener("blur", handleWindowBlur);
				document.documentElement.removeEventListener(
					"mouseleave",
					handleMouseLeave,
				);
				setDragState(null);
				setDropTargetIndex(null);
			});
		}
	});

	const handleMouseDown = (ann: Annotation, e: MouseEvent) => {
		if ((e.target as HTMLElement).closest("button")) return;

		const gripHandle = (e.target as HTMLElement).closest("[data-grip-handle]");
		if (!gripHandle) return;

		e.preventDefault();
		e.stopPropagation();

		setDragState({
			draggedId: ann.id,
			startY: e.clientY,
			currentY: e.clientY,
		});
	};

	const handleLayerClick = (ann: Annotation, e: MouseEvent) => {
		if ((e.target as HTMLElement).closest("[data-grip-handle]")) return;
		setSelectedAnnotationId(ann.id);
		setActiveTool("select");
		setFocusAnnotationId(ann.id);
	};

	const handleDelete = (id: string, e: MouseEvent) => {
		e.stopPropagation();
		projectHistory.push();
		setAnnotations((prev) => prev.filter((a) => a.id !== id));
		if (selectedAnnotationId() === id) {
			setSelectedAnnotationId(null);
		}
	};

	createEffect(
		on(
			() => annotations.length,
			() => {
				setDragState(null);
				setDropTargetIndex(null);
			},
		),
	);

	return (
		<div class="flex flex-col h-full w-56 border-r border-gray-3 bg-gray-1 dark:bg-gray-2 select-none z-20">
			<div class="flex items-center justify-between px-3 h-10 border-b border-gray-3">
				<div class="flex items-center gap-2 text-sm font-medium text-gray-12">
					<IconLucideLayers class="size-4" />
					<span>Layers</span>
				</div>
				<button
					type="button"
					onClick={() => setLayersPanelOpen(false)}
					class="p-1 rounded hover:bg-gray-3 text-gray-11 hover:text-gray-12 transition-colors"
				>
					<IconLucideX class="size-4" />
				</button>
			</div>

			<div class="flex-1 overflow-y-auto py-1" data-layers-list>
				<Show
					when={annotations.length > 0}
					fallback={
						<div class="flex flex-col items-center justify-center h-full px-4 text-center">
							<IconLucideLayers class="size-8 text-gray-7 mb-2" />
							<p class="text-xs text-gray-10">No layers yet</p>
							<p class="text-[10px] text-gray-8 mt-1">
								Use the tools above to add annotations
							</p>
						</div>
					}
				>
					<For each={reversedAnnotations()}>
						{(ann, reversedIdx) => {
							const Icon = ANNOTATION_TYPE_ICONS[ann.type];
							const isSelected = () => selectedAnnotationId() === ann.id;
							const isDragging = () => dragState()?.draggedId === ann.id;
							const isDropTarget = () => {
								const target = dropTargetIndex();
								return target !== null && target === reversedIdx();
							};
							const showDropIndicatorAfter = () => {
								const target = dropTargetIndex();
								const state = dragState();
								if (!state || target === null) return false;
								const draggedIdx = reversedAnnotations().findIndex(
									(a) => a.id === state.draggedId,
								);
								return (
									target === reversedIdx() + 1 && target !== draggedIdx + 1
								);
							};

							return (
								<>
									<Show when={isDropTarget() && !isDragging()}>
										<div class="h-0.5 bg-blue-9 mx-2 rounded-full" />
									</Show>
									<div
										data-layer-item
										onMouseDown={(e) => handleMouseDown(ann, e)}
										onClick={(e) => handleLayerClick(ann, e)}
										class={cx(
											"flex items-center gap-2 px-2 py-1.5 mx-1 rounded-md cursor-pointer transition-all group",
											isSelected()
												? "bg-blue-3 dark:bg-blue-4"
												: "hover:bg-gray-3",
											isDragging() && "opacity-50 bg-gray-3",
										)}
									>
										<div
											data-grip-handle
											class="cursor-grab active:cursor-grabbing text-gray-8 hover:text-gray-11 transition-colors"
										>
											<IconLucideGripVertical class="size-3.5" />
										</div>

										<div
											class={cx(
												"flex items-center justify-center size-6 rounded",
												isSelected()
													? "bg-blue-5 text-blue-11"
													: "bg-gray-3 text-gray-11",
											)}
										>
											<Icon class="size-3.5" />
										</div>

										<span
											class={cx(
												"flex-1 text-xs truncate",
												isSelected() ? "text-blue-12" : "text-gray-12",
											)}
										>
											{getTypeLabel(ann)}
										</span>

										<button
											type="button"
											onClick={(e) => handleDelete(ann.id, e)}
											class="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-red-3 text-gray-9 hover:text-red-11 transition-all"
										>
											<IconLucideX class="size-3" />
										</button>
									</div>
									<Show when={showDropIndicatorAfter()}>
										<div class="h-0.5 bg-blue-9 mx-2 rounded-full" />
									</Show>
								</>
							);
						}}
					</For>
					<Show
						when={
							dropTargetIndex() === reversedAnnotations().length && dragState()
						}
					>
						<div class="h-0.5 bg-blue-9 mx-2 rounded-full" />
					</Show>
				</Show>
			</div>

			<div class="px-3 py-2 border-t border-gray-3 text-[10px] text-gray-9">
				Drag to reorder • Top = front
			</div>
		</div>
	);
}
