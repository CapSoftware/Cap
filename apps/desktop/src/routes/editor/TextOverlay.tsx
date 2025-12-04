import { createEventListenerMap } from "@solid-primitives/event-listener";
import { cx } from "cva";
import { createEffect, createMemo, createRoot, on, Show } from "solid-js";
import { produce } from "solid-js/store";

import { useEditorContext } from "./context";
import type { TextSegment } from "./text";

type TextOverlayProps = {
	size: { width: number; height: number };
};

export function TextOverlay(props: TextOverlayProps) {
	const { project, setProject, editorState, projectHistory } =
		useEditorContext();

	const selectedText = createMemo(() => {
		const selection = editorState.timeline.selection;
		if (!selection || selection.type !== "text") return;
		const index = selection.indices[0];
		const segment = project.timeline?.textSegments?.[index];
		if (!segment) return;
		return { index, segment };
	});

	const clamp = (value: number, min: number, max: number) =>
		Math.min(Math.max(value, min), max);

	const updateSegment = (fn: (segment: TextSegment) => void) => {
		const index = selectedText()?.index;
		if (index === undefined) return;
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

	return (
		<Show when={selectedText()}>
			{(selected) => {
				const segment = () => selected().segment;

				// Measurement Logic
				let hiddenMeasureRef: HTMLDivElement | undefined;

				createEffect(
					on(
						() => ({
							content: segment().content,
							fontFamily: segment().fontFamily,
							fontSize: segment().fontSize,
							fontWeight: segment().fontWeight,
							italic: segment().italic,
							containerWidth: props.size.width,
							containerHeight: props.size.height,
						}),
						(deps) => {
							if (!hiddenMeasureRef) return;

							const { width: naturalWidth, height: naturalHeight } =
								hiddenMeasureRef.getBoundingClientRect();

							if (
								naturalWidth === 0 ||
								naturalHeight === 0 ||
								!deps.containerWidth ||
								!deps.containerHeight
							)
								return;

							// Normalize to [0-1]
							const normalizedWidth = naturalWidth / deps.containerWidth;
							const normalizedHeight = naturalHeight / deps.containerHeight;

							const _newFontSize = deps.fontSize;
							const newSizeX = normalizedWidth;
							const newSizeY = normalizedHeight;

							// Logic simplified: Trust the measurement.

							// Update if significant difference to avoid loops
							const sizeXDiff = Math.abs(newSizeX - segment().size.x);
							const sizeYDiff = Math.abs(newSizeY - segment().size.y);
							// const fontDiff = Math.abs(newFontSize - segment().fontSize); // We aren't changing font size anymore

							if (sizeXDiff > 0.001 || sizeYDiff > 0.001) {
								updateSegment((s) => {
									const oldHeight = s.size.y;
									s.size.x = newSizeX;
									s.size.y = newSizeY;
									// s.fontSize = newFontSize; // Don't override font size

									// Adjust Center Y to keep top anchor fixed (growing down)
									// If height changes by diff, center moves by diff/2
									const diff = newSizeY - oldHeight;
									s.center.y += diff / 2;

									// Frame constraints for center
									const halfH = s.size.y / 2;
									const halfW = s.size.x / 2;

									if (s.center.y + halfH > 1) {
										s.center.y -= s.center.y + halfH - 1;
									}
									if (s.center.y - halfH < 0) {
										s.center.y += 0 - (s.center.y - halfH);
									}
									if (s.center.x + halfW > 1) {
										s.center.x -= s.center.x + halfW - 1;
									}
									if (s.center.x - halfW < 0) {
										s.center.x += 0 - (s.center.x - halfW);
									}
								});
							}
						},
					),
				);

				const rect = () => {
					const width = segment().size.x * props.size.width;
					const height = segment().size.y * props.size.height;
					const left = segment().center.x * props.size.width - width / 2;
					const top = segment().center.y * props.size.height - height / 2;
					return { width, height, left, top };
				};

				const onMove = createMouseDownDrag(
					() => ({
						startPos: { ...segment().center },
						startSize: { ...segment().size },
					}),
					(e, { startPos, startSize }, initialMouse) => {
						const dx = (e.clientX - initialMouse.x) / props.size.width;
						const dy = (e.clientY - initialMouse.y) / props.size.height;

						updateSegment((s) => {
							const newX = startPos.x + dx;
							const newY = startPos.y + dy;

							// Constrain to frame
							const halfW = startSize.x / 2;
							const halfH = startSize.y / 2;

							s.center.x = clamp(newX, halfW, 1 - halfW);
							s.center.y = clamp(newY, halfH, 1 - halfH);
						});
					},
				);

				const createResizeHandler = (dirX: -1 | 0 | 1, dirY: -1 | 0 | 1) => {
					return createMouseDownDrag(
						() => ({
							startPos: { ...segment().center },
							startSize: { ...segment().size },
							startFontSize: segment().fontSize,
						}),
						(e, { startPos, startSize, startFontSize }, initialMouse) => {
							const dx = (e.clientX - initialMouse.x) / props.size.width;
							const dy = (e.clientY - initialMouse.y) / props.size.height;

							updateSegment((s) => {
								// If Corner Drag -> Scale (change fontSize and Width)
								// If Side Drag -> Change Width (reflow)

								const isCorner = dirX !== 0 && dirY !== 0;
								const isSide = dirX !== 0 && dirY === 0;

								if (isSide) {
									// Standard resize logic: updates width, keeps center relative or fixed
									const targetWidth = startSize.x + dx * dirX;
									const clampedWidth = clamp(targetWidth, 0.05, 1);
									const appliedDelta = clampedWidth - startSize.x;

									s.size.x = clampedWidth;
									s.center.x = clamp(
										startPos.x + (dirX * appliedDelta) / 2,
										s.size.x / 2,
										1 - s.size.x / 2,
									);
								} else if (isCorner) {
									// Scale uniformly
									const _currentWidthPx = startSize.x * props.size.width;
									const currentHeightPx = startSize.y * props.size.height;

									const _deltaPxX = dx * props.size.width * dirX;
									const deltaPxY = dy * props.size.height * dirY;

									const scaleY = (currentHeightPx + deltaPxY) / currentHeightPx;
									const scale = scaleY;

									if (scale > 0.1) {
										s.fontSize = clamp(startFontSize * scale, 8, 400);
										// Also scale width to maintain aspect ratio of the box
										s.size.x = clamp(startSize.x * scale, 0.05, 1);

										// Update center
										const widthDiff = s.size.x - startSize.x;
										const approxHeightDiff = startSize.y * scale - startSize.y;

										s.center.x = clamp(
											startPos.x + (widthDiff * dirX) / 2,
											s.size.x / 2,
											1 - s.size.x / 2,
										);
										s.center.y = clamp(
											startPos.y + (approxHeightDiff * dirY) / 2,
											s.size.y / 2, // Use calculated height for clamping? Approximation
											1 - s.size.y / 2,
										);
									}
								}
							});
						},
					);
				};

				return (
					<div class="absolute inset-0 pointer-events-none">
						{/* Hidden Measurement Div */}
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
								// Use fixed width if we want to support wrapping when large?
								// Or max-width?
								// If we allow wrapping, we should set max-width to container width.
								"max-width": `${props.size.width}px`,
								width: "fit-content",
								height: "auto",
								top: "0",
								left: "0",
							}}
						>
							{segment().content}
							{/* Ensure height for empty lines if needed, though pre-wrap usually handles it */}
							{segment().content.endsWith("\n") ? <br /> : null}
						</div>

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
							{/* Visual placeholder (not used for measurement anymore) */}
							<div
								style={{
									"white-space": "pre-wrap",
									"word-break": "break-word",
									"font-family": segment().fontFamily,
									"font-size": `${segment().fontSize}px`,
									"font-weight": segment().fontWeight,
									"font-style": segment().italic ? "italic" : "normal",
									color: segment().color,
									"line-height": 1.2,
									width: "100%",
									height: "100%",
									display: "flex",
									"align-items": "center",
									"justify-content": "center",
									"text-align": "center",
									"pointer-events": "none",
									opacity: 0,
								}}
								class="w-full h-full overflow-hidden"
							>
								{segment().content}
							</div>

							<div class="absolute inset-0 rounded-md border-2 border-blue-9 bg-blue-9/10 cursor-move" />
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
