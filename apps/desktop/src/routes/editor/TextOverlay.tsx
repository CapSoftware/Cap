import { createEventListenerMap } from "@solid-primitives/event-listener";
import { cx } from "cva";
import {
	createEffect,
	createMemo,
	createRoot,
	createSignal,
	For,
	on,
	onCleanup,
	onMount,
} from "solid-js";
import { produce } from "solid-js/store";
import type { TextSegment as TauriTextSegment } from "~/utils/tauri";
import { useEditorContext } from "./context";
import type { TextSegment } from "./text";

type TextOverlayProps = {
	size: { width: number; height: number };
};

export function TextOverlay(props: TextOverlayProps) {
	const { project, setProject, editorState, setEditorState, projectHistory } =
		useEditorContext();

	const currentAbsoluteTime = () =>
		editorState.previewTime ?? editorState.playbackTime ?? 0;

	const visibleTextSegments = createMemo(() => {
		const segments = project.timeline?.textSegments ?? [];
		const time = currentAbsoluteTime();
		return segments
			.map((segment, index) => ({ segment, index }))
			.filter(({ segment }) => time >= segment.start && time < segment.end);
	});

	const selectedTextIndex = createMemo(() => {
		const selection = editorState.timeline.selection;
		if (!selection || selection.type !== "text") return null;
		return selection.indices[0] ?? null;
	});

	const clamp = (value: number, min: number, max: number) => {
		if (min > max) {
			return (min + max) / 2;
		}
		return Math.min(Math.max(value, min), max);
	};

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
					mouseup: (event) => {
						handleUpdate(event);
						finish();
					},
				});
				return dispose;
			});
		};
	}

	const handleSelectSegment = (index: number, e: MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setEditorState("timeline", "selection", {
			type: "text",
			indices: [index],
		});
	};

	const handleBackgroundClick = (e: MouseEvent) => {
		if (e.target === e.currentTarget && selectedTextIndex() !== null) {
			e.preventDefault();
			e.stopPropagation();
			setEditorState("timeline", "selection", null);
		}
	};

	const hasTextSelection = () => selectedTextIndex() !== null;

	return (
		<div
			class="absolute inset-0"
			classList={{ "pointer-events-none": !hasTextSelection() }}
			onMouseDown={handleBackgroundClick}
		>
			<For each={visibleTextSegments()}>
				{({ segment, index }) => (
					<TextSegmentOverlay
						size={props.size}
						segment={segment}
						index={index}
						isSelected={selectedTextIndex() === index}
						onSelect={(e) => handleSelectSegment(index, e)}
						updateSegment={(fn) => updateSegmentByIndex(index, fn)}
						createMouseDownDrag={createMouseDownDrag}
						clamp={clamp}
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
	color: string;
};

function normalizeSegment(segment: TauriTextSegment): SegmentWithDefaults {
	return {
		start: segment.start,
		end: segment.end,
		enabled: segment.enabled ?? true,
		content: segment.content ?? "Text",
		center: segment.center ?? { x: 0.5, y: 0.5 },
		size: segment.size ?? { x: 0.01, y: 0.01 },
		fontFamily: segment.fontFamily ?? "sans-serif",
		fontSize: segment.fontSize ?? 48,
		fontWeight: segment.fontWeight ?? 700,
		italic: segment.italic ?? false,
		color: segment.color ?? "#ffffff",
	};
}

function TextSegmentOverlay(props: {
	size: { width: number; height: number };
	segment: TauriTextSegment;
	index: number;
	isSelected: boolean;
	onSelect: (e: MouseEvent) => void;
	updateSegment: (fn: (segment: TextSegment) => void) => void;
	createMouseDownDrag: <T>(
		setup: () => T,
		update: (
			e: MouseEvent,
			value: T,
			initialMouse: { x: number; y: number },
		) => void,
	) => (downEvent: MouseEvent) => void;
	clamp: (value: number, min: number, max: number) => number;
}) {
	const segment = createMemo(() => normalizeSegment(props.segment));
	let hiddenMeasureRef: HTMLDivElement | undefined;
	const [mounted, setMounted] = createSignal(false);
	const [isResizing, setIsResizing] = createSignal(false);
	let pendingResizeCleanup: (() => void) | null = null;

	onMount(() => {
		setMounted(true);
	});

	onCleanup(() => {
		if (pendingResizeCleanup) {
			pendingResizeCleanup();
			pendingResizeCleanup = null;
		}
		setIsResizing(false);
	});

	const isDefaultSize = (size: { x: number; y: number }) =>
		size.x <= 0.025 || size.y <= 0.025;

	const [lastContent, setLastContent] = createSignal(segment().content);
	const [lastFontSize, setLastFontSize] = createSignal(segment().fontSize);

	const measureAndUpdateSize = (forceUpdate = false) => {
		if (!hiddenMeasureRef) return false;

		const seg = segment();
		if (!forceUpdate && !isDefaultSize(seg.size)) return true;

		const { width: naturalWidth, height: naturalHeight } =
			hiddenMeasureRef.getBoundingClientRect();

		if (
			naturalWidth === 0 ||
			naturalHeight === 0 ||
			!props.size.width ||
			!props.size.height
		)
			return false;

		const normalizedWidth = naturalWidth / props.size.width;
		const normalizedHeight = naturalHeight / props.size.height;

		props.updateSegment((s) => {
			s.size.x = normalizedWidth;
			s.size.y = normalizedHeight;
		});
		return true;
	};

	createEffect(
		on(
			() => ({
				mounted: mounted(),
				containerWidth: props.size.width,
				containerHeight: props.size.height,
			}),
			() => {
				if (!mounted()) return;
				const tryMeasure = () => {
					if (!measureAndUpdateSize()) {
						requestAnimationFrame(tryMeasure);
					}
				};
				queueMicrotask(tryMeasure);
			},
		),
	);

	createEffect(
		on(
			() => ({
				content: segment().content,
				fontSize: segment().fontSize,
				fontWeight: segment().fontWeight,
				fontFamily: segment().fontFamily,
				italic: segment().italic,
			}),
			(current) => {
				if (!mounted()) return;
				if (isResizing()) return;

				const contentChanged = current.content !== lastContent();
				const fontSizeChanged = current.fontSize !== lastFontSize();

				if (contentChanged || fontSizeChanged) {
					setLastContent(current.content);
					setLastFontSize(current.fontSize);

					queueMicrotask(() => {
						requestAnimationFrame(() => {
							if (!isResizing()) {
								measureAndUpdateSize(true);
							}
						});
					});
				}
			},
		),
	);

	const rect = () => {
		const seg = segment();
		const minDimension = 20;
		const width = Math.max(seg.size.x * props.size.width, minDimension);
		const height = Math.max(seg.size.y * props.size.height, minDimension);
		const left = Math.max(0, seg.center.x * props.size.width - width / 2);
		const top = Math.max(0, seg.center.y * props.size.height - height / 2);
		return { width, height, left, top };
	};

	const onMove = props.createMouseDownDrag(
		() => {
			const seg = segment();
			return {
				startPos: { ...seg.center },
				startSize: { ...seg.size },
			};
		},
		(e, { startPos, startSize }, initialMouse) => {
			const dx = (e.clientX - initialMouse.x) / props.size.width;
			const dy = (e.clientY - initialMouse.y) / props.size.height;

			const minPadding = 0.02;

			props.updateSegment((s) => {
				const newX = startPos.x + dx;
				const newY = startPos.y + dy;

				const halfW = s.size.x / 2;
				const halfH = s.size.y / 2;

				s.center.x = props.clamp(
					newX,
					halfW + minPadding,
					1 - halfW - minPadding,
				);
				s.center.y = props.clamp(
					newY,
					halfH + minPadding,
					1 - halfH - minPadding,
				);
			});
		},
	);

	const createResizeHandler = (dirX: -1 | 0 | 1, dirY: -1 | 0 | 1) => {
		const isCorner = dirX !== 0 && dirY !== 0;

		const handler = props.createMouseDownDrag(
			() => {
				if (isCorner) {
					setIsResizing(true);
				}
				const seg = segment();
				return {
					startPos: { ...seg.center },
					startSize: { ...seg.size },
					startFontSize: seg.fontSize,
				};
			},
			(e, { startPos, startSize, startFontSize }, initialMouse) => {
				const dx = (e.clientX - initialMouse.x) / props.size.width;
				const dy = (e.clientY - initialMouse.y) / props.size.height;

				const isSide = dirX !== 0 && dirY === 0;

				const minSize = 0.03;
				const maxSize = 0.95;
				const minPadding = 0.02;

				props.updateSegment((s) => {
					if (isSide) {
						const targetWidth = startSize.x + dx * dirX;
						const clampedWidth = props.clamp(targetWidth, minSize, maxSize);
						const appliedDelta = clampedWidth - startSize.x;

						s.size.x = clampedWidth;

						const halfWidth = s.size.x / 2;
						const halfHeight = s.size.y / 2;
						s.center.x = props.clamp(
							startPos.x + (dirX * appliedDelta) / 2,
							halfWidth + minPadding,
							1 - halfWidth - minPadding,
						);
						s.center.y = props.clamp(
							s.center.y,
							halfHeight + minPadding,
							1 - halfHeight - minPadding,
						);
					} else if (isCorner) {
						const currentHeightPx = startSize.y * props.size.height;
						const deltaPxY = dy * props.size.height * dirY;

						const scaleY = (currentHeightPx + deltaPxY) / currentHeightPx;
						const scale = scaleY;

						if (scale > 0.1 && scale < 10) {
							const newFontSize = props.clamp(startFontSize * scale, 8, 400);
							const newSizeX = props.clamp(
								startSize.x * scale,
								minSize,
								maxSize,
							);
							const newSizeY = props.clamp(
								startSize.y * scale,
								minSize,
								maxSize,
							);

							s.fontSize = newFontSize;
							s.size.x = newSizeX;
							s.size.y = newSizeY;

							const widthDiff = s.size.x - startSize.x;
							const heightDiff = s.size.y - startSize.y;

							const halfWidth = s.size.x / 2;
							const halfHeight = s.size.y / 2;
							s.center.x = props.clamp(
								startPos.x + (widthDiff * dirX) / 2,
								halfWidth + minPadding,
								1 - halfWidth - minPadding,
							);
							s.center.y = props.clamp(
								startPos.y + (heightDiff * dirY) / 2,
								halfHeight + minPadding,
								1 - halfHeight - minPadding,
							);
						}
					}
				});
			},
		);

		return (downEvent: MouseEvent) => {
			handler(downEvent);
			if (isCorner) {
				const onMouseUp = () => {
					setIsResizing(false);
					window.removeEventListener("mouseup", onMouseUp);
					pendingResizeCleanup = null;
				};
				window.addEventListener("mouseup", onMouseUp);
				pendingResizeCleanup = () => {
					setIsResizing(false);
					window.removeEventListener("mouseup", onMouseUp);
				};
			}
		};
	};

	return (
		<>
			<div
				ref={hiddenMeasureRef}
				style={{
					position: "absolute",
					visibility: "hidden",
					"white-space": "pre-wrap",
					"word-break": "break-word",
					"font-family": segment().fontFamily,
					"font-size": `${segment().fontSize}px`,
					"font-weight": segment().fontWeight,
					"font-style": segment().italic ? "italic" : "normal",
					"line-height": 1.2,
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
					"cursor-move": !props.isSelected,
					group: props.isSelected,
				}}
				style={{
					left: `${rect().left}px`,
					top: `${rect().top}px`,
					width: `${rect().width}px`,
					height: `${rect().height}px`,
				}}
				onMouseDown={(e) => {
					if (!props.isSelected) {
						props.onSelect(e);
					}
					onMove(e);
				}}
			>
				<div
					class="absolute inset-0 rounded-md border-2 transition-colors"
					classList={{
						"border-blue-9 bg-blue-9/10 cursor-move": props.isSelected,
						"border-transparent hover:border-blue-6 hover:bg-blue-9/5 cursor-pointer":
							!props.isSelected,
					}}
				/>
				{props.isSelected && (
					<>
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
							class="left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-w-resize"
							onMouseDown={createResizeHandler(-1, 0)}
						/>
						<ResizeHandle
							class="right-0 top-1/2 translate-x-1/2 -translate-y-1/2 cursor-e-resize"
							onMouseDown={createResizeHandler(1, 0)}
						/>
					</>
				)}
			</div>
		</>
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
