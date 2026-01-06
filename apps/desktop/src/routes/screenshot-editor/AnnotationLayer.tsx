import {
	createEffect,
	createMemo,
	createSignal,
	For,
	onCleanup,
	Show,
} from "solid-js";
import { unwrap } from "solid-js/store";
import { getArrowHeadPoints } from "./arrow";
import {
	type Annotation,
	type AnnotationType,
	type ScreenshotProject,
	useScreenshotEditorContext,
} from "./context";

export function AnnotationLayer(props: {
	bounds: { x: number; y: number; width: number; height: number };
	cssWidth: number;
	cssHeight: number;
	imageRect: { x: number; y: number; width: number; height: number };
}) {
	const {
		project,
		annotations,
		setAnnotations,
		activeTool,
		setActiveTool,
		selectedAnnotationId,
		setSelectedAnnotationId,
		projectHistory,
	} = useScreenshotEditorContext();

	const [isDrawing, setIsDrawing] = createSignal(false);
	const [dragState, setDragState] = createSignal<{
		id: string;
		action: "move" | "resize";
		handle?: string;
		startX: number;
		startY: number;
		original: Annotation;
	} | null>(null);

	// History snapshots
	let dragSnapshot: {
		project: ScreenshotProject;
		annotations: Annotation[];
	} | null = null;
	let drawSnapshot: {
		project: ScreenshotProject;
		annotations: Annotation[];
	} | null = null;
	let textSnapshot: {
		project: ScreenshotProject;
		annotations: Annotation[];
	} | null = null;

	const [textEditingId, setTextEditingId] = createSignal<string | null>(null);

	// Temporary annotation being drawn
	const [tempAnnotation, setTempAnnotation] = createSignal<Annotation | null>(
		null,
	);

	const clampValue = (value: number, min: number, max: number) =>
		Math.min(Math.max(value, min), max);

	// Delete key handler
	createEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (textEditingId()) return;
			if (e.key === "Backspace" || e.key === "Delete") {
				const id = selectedAnnotationId();
				if (id) {
					projectHistory.push(); // Save current state before delete
					setAnnotations((prev) => prev.filter((a) => a.id !== id));
					setSelectedAnnotationId(null);
				}
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		onCleanup(() => window.removeEventListener("keydown", handleKeyDown));
	});

	createEffect(() => {
		const rect = props.imageRect;
		if (rect.width <= 0 || rect.height <= 0) return;
		const currentlyDrawingId = isDrawing() ? tempAnnotation()?.id : null;
		const masksToRemove: string[] = [];
		for (const ann of annotations) {
			if (ann.type !== "mask") continue;
			if (ann.id === currentlyDrawingId) continue;
			const left = clampValue(
				Math.min(ann.x, ann.x + ann.width),
				rect.x,
				rect.x + rect.width,
			);
			const right = clampValue(
				Math.max(ann.x, ann.x + ann.width),
				rect.x,
				rect.x + rect.width,
			);
			const top = clampValue(
				Math.min(ann.y, ann.y + ann.height),
				rect.y,
				rect.y + rect.height,
			);
			const bottom = clampValue(
				Math.max(ann.y, ann.y + ann.height),
				rect.y,
				rect.y + rect.height,
			);
			const width = Math.max(0, right - left);
			const height = Math.max(0, bottom - top);
			if (width < 5 || height < 5) {
				masksToRemove.push(ann.id);
				continue;
			}
			if (
				left !== Math.min(ann.x, ann.x + ann.width) ||
				top !== Math.min(ann.y, ann.y + ann.height) ||
				width !== Math.abs(ann.width) ||
				height !== Math.abs(ann.height)
			) {
				setAnnotations((a) => a.id === ann.id, {
					x: left,
					y: top,
					width,
					height,
				});
			}
		}
		if (masksToRemove.length > 0) {
			setAnnotations((prev) =>
				prev.filter((a) => !masksToRemove.includes(a.id)),
			);
		}
	});

	// Helper to get coordinates in SVG space
	const getSvgPoint = (
		e: MouseEvent,
		svg: SVGSVGElement,
	): { x: number; y: number } => {
		const rect = svg.getBoundingClientRect();
		const x = e.clientX - rect.left;
		const y = e.clientY - rect.top;
		// Scale to viewBox
		return {
			x: props.bounds.x + (x / rect.width) * props.bounds.width,
			y: props.bounds.y + (y / rect.height) * props.bounds.height,
		};
	};

	const handleMouseDown = (e: MouseEvent) => {
		// If editing text, click outside commits change (handled by blur on input usually, but safety here)
		if (textEditingId()) {
			// If clicking inside the text editor, don't stop
			if ((e.target as HTMLElement).closest(".text-editor")) return;
			setTextEditingId(null);
		}

		const tool = activeTool();

		if (tool === "select") {
			if (e.target === e.currentTarget) {
				setSelectedAnnotationId(null);
			}
			return;
		}

		// Snapshot for drawing
		drawSnapshot = {
			project: structuredClone(unwrap(project)),
			annotations: structuredClone(unwrap(annotations)),
		};

		const svg = e.currentTarget as SVGSVGElement;
		const point = getSvgPoint(e, svg);
		const startX =
			tool === "mask"
				? clampValue(
						point.x,
						props.imageRect.x,
						props.imageRect.x + props.imageRect.width,
					)
				: point.x;
		const startY =
			tool === "mask"
				? clampValue(
						point.y,
						props.imageRect.y,
						props.imageRect.y + props.imageRect.height,
					)
				: point.y;

		setIsDrawing(true);
		const id = crypto.randomUUID();
		const newAnn: Annotation = {
			id,
			type: tool as AnnotationType,
			x: startX,
			y: startY,
			width: 0,
			height: 0,
			strokeColor: tool === "mask" ? "transparent" : "#F05656",
			strokeWidth: tool === "mask" ? 0 : 4,
			fillColor: "transparent",
			opacity: 1,
			rotation: 0,
			text: tool === "text" ? "Text" : null,
			maskType: tool === "mask" ? "pixelate" : null,
			maskLevel: tool === "mask" ? 7 : null,
		};

		if (tool === "text") {
			newAnn.height = 40; // Default font size
			newAnn.width = 150; // Default width
		}

		setTempAnnotation(newAnn);

		if (tool === "mask") {
			setAnnotations((prev) => [...prev, newAnn]);
		}
	};

	const handleMouseMove = (e: MouseEvent) => {
		const svg = e.currentTarget as SVGSVGElement;
		const point = getSvgPoint(e, svg);

		if (isDrawing() && tempAnnotation()) {
			const temp = tempAnnotation();
			if (!temp) return;
			if (temp.type === "text") return;

			const currentX =
				temp.type === "mask"
					? clampValue(
							point.x,
							props.imageRect.x,
							props.imageRect.x + props.imageRect.width,
						)
					: point.x;
			const currentY =
				temp.type === "mask"
					? clampValue(
							point.y,
							props.imageRect.y,
							props.imageRect.y + props.imageRect.height,
						)
					: point.y;

			let width = currentX - temp.x;
			let height = currentY - temp.y;

			if (temp.type === "circle" && !e.shiftKey) {
				const size = Math.max(Math.abs(width), Math.abs(height));
				width = width < 0 ? -size : size;
				height = height < 0 ? -size : size;
			} else if (e.shiftKey) {
				if (temp.type === "rectangle" || temp.type === "mask") {
					const size = Math.max(Math.abs(width), Math.abs(height));
					width = width < 0 ? -size : size;
					height = height < 0 ? -size : size;
				} else if (temp.type === "arrow") {
					const angle = Math.atan2(height, width);
					const snap = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
					const dist = Math.sqrt(width * width + height * height);
					width = Math.cos(snap) * dist;
					height = Math.sin(snap) * dist;
				}
			}

			const next = { ...temp, width, height };
			setTempAnnotation(next);
			if (temp.type === "mask") {
				setAnnotations((a) => a.id === temp.id, next);
			}
			return;
		}

		if (dragState()) {
			const state = dragState();
			if (!state) return;
			const dx = point.x - state.startX;
			const dy = point.y - state.startY;

			if (state.action === "move") {
				setAnnotations(
					(a) => a.id === state.id,
					(a) => {
						const nextX =
							a.type === "mask"
								? clampValue(
										state.original.x + dx,
										props.imageRect.x,
										props.imageRect.x + props.imageRect.width - a.width,
									)
								: state.original.x + dx;
						const nextY =
							a.type === "mask"
								? clampValue(
										state.original.y + dy,
										props.imageRect.y,
										props.imageRect.y + props.imageRect.height - a.height,
									)
								: state.original.y + dy;
						return {
							...a,
							x: nextX,
							y: nextY,
						};
					},
				);
			} else if (state.action === "resize" && state.handle) {
				const original = state.original;
				let newX = original.x;
				let newY = original.y;
				let newW = original.width;
				let newH = original.height;

				// For arrow: 'start' and 'end' handles
				if (original.type === "arrow") {
					if (state.handle === "start") {
						newX = original.x + dx;
						newY = original.y + dy;
						newW = original.width - dx;
						newH = original.height - dy;
					} else if (state.handle === "end") {
						newW = original.width + dx;
						newH = original.height + dy;
					}
				} else {
					// For shapes
					if (state.handle.includes("e")) newW = original.width + dx;
					if (state.handle.includes("s")) newH = original.height + dy;
					if (state.handle.includes("w")) {
						newX = original.x + dx;
						newW = original.width - dx;
					}
					if (state.handle.includes("n")) {
						newY = original.y + dy;
						newH = original.height - dy;
					}

					const shouldConstrainCircle =
						original.type === "circle" && !e.shiftKey;
					const shouldConstrainRectangle =
						original.type === "rectangle" && e.shiftKey;

					if (shouldConstrainCircle || shouldConstrainRectangle) {
						const size = Math.max(Math.abs(newW), Math.abs(newH));
						const signW = newW < 0 ? -1 : 1;
						const signH = newH < 0 ? -1 : 1;

						if (state.handle.includes("w")) {
							newX = original.x + original.width - signW * size;
						}
						if (state.handle.includes("n")) {
							newY = original.y + original.height - signH * size;
						}

						newW = signW * size;
						newH = signH * size;
					}
				}

				if (original.type === "mask") {
					const rectLeft = props.imageRect.x;
					const rectTop = props.imageRect.y;
					const rectRight = props.imageRect.x + props.imageRect.width;
					const rectBottom = props.imageRect.y + props.imageRect.height;
					const left = Math.min(newX, newX + newW);
					const right = Math.max(newX, newX + newW);
					const top = Math.min(newY, newY + newH);
					const bottom = Math.max(newY, newY + newH);
					const clampedLeft = clampValue(left, rectLeft, rectRight);
					const clampedRight = clampValue(right, rectLeft, rectRight);
					const clampedTop = clampValue(top, rectTop, rectBottom);
					const clampedBottom = clampValue(bottom, rectTop, rectBottom);
					newX = clampedLeft;
					newY = clampedTop;
					newW = Math.max(0, clampedRight - clampedLeft);
					newH = Math.max(0, clampedBottom - clampedTop);
				}

				setAnnotations((a) => a.id === state.id, {
					x: newX,
					y: newY,
					width: newW,
					height: newH,
				});
			}
		}
	};

	const handleMouseUp = () => {
		const tempAnn = tempAnnotation();
		if (isDrawing() && tempAnn) {
			const ann = { ...tempAnn };
			if (
				ann.type === "rectangle" ||
				ann.type === "circle" ||
				ann.type === "mask"
			) {
				if (ann.width < 0) {
					ann.x += ann.width;
					ann.width = Math.abs(ann.width);
				}
				if (ann.height < 0) {
					ann.y += ann.height;
					ann.height = Math.abs(ann.height);
				}
				if (ann.type === "mask") {
					const rectLeft = props.imageRect.x;
					const rectTop = props.imageRect.y;
					const rectRight = props.imageRect.x + props.imageRect.width;
					const rectBottom = props.imageRect.y + props.imageRect.height;
					const clampedLeft = clampValue(ann.x, rectLeft, rectRight);
					const clampedTop = clampValue(ann.y, rectTop, rectBottom);
					const clampedRight = clampValue(
						ann.x + ann.width,
						rectLeft,
						rectRight,
					);
					const clampedBottom = clampValue(
						ann.y + ann.height,
						rectTop,
						rectBottom,
					);
					ann.x = clampedLeft;
					ann.y = clampedTop;
					ann.width = Math.max(0, clampedRight - clampedLeft);
					ann.height = Math.max(0, clampedBottom - clampedTop);
				}
				if (ann.width < 5 && ann.height < 5) {
					setTempAnnotation(null);
					setIsDrawing(false);
					if (ann.type === "mask") {
						setAnnotations((prev) => prev.filter((a) => a.id !== ann.id));
					}
					drawSnapshot = null;
					return;
				}
			}

			if (drawSnapshot) projectHistory.push(drawSnapshot);
			drawSnapshot = null;

			if (ann.type === "mask") {
				setAnnotations((a) => a.id === ann.id, ann);
			} else {
				setAnnotations((prev) => [...prev, ann]);
			}
			setTempAnnotation(null);
			setIsDrawing(false);
			setActiveTool("select");
			setSelectedAnnotationId(ann.id);

			if (ann.type === "text") {
				textSnapshot = {
					project: structuredClone(unwrap(project)),
					annotations: structuredClone(unwrap(annotations)),
				};
				setTextEditingId(ann.id);
			}
		}

		if (dragState()) {
			// Commit history if changed
			// We can check if current annotations differ from snapshot, but that's expensive.
			// Instead, we assume if we dragged, we changed.
			// We need to know if we actually moved.
			// But we don't have "current" vs "original" easily without checking.
			// Simpler: always push if dragSnapshot exists.
			if (dragSnapshot) {
				projectHistory.push(dragSnapshot);
			}
			dragSnapshot = null;
		}

		setDragState(null);
	};

	const startDrag = (e: MouseEvent, id: string, handle?: string) => {
		e.stopPropagation();
		if (activeTool() !== "select") return;

		const svg = (e.currentTarget as Element).closest("svg");
		if (!svg) return;
		const point = getSvgPoint(e, svg);
		const annotation = annotations.find((a) => a.id === id);

		if (annotation) {
			// Snapshot for dragging
			dragSnapshot = {
				project: structuredClone(unwrap(project)),
				annotations: structuredClone(unwrap(annotations)),
			};

			setSelectedAnnotationId(id);
			setDragState({
				id,
				action: handle ? "resize" : "move",
				handle,
				startX: point.x,
				startY: point.y,
				original: { ...annotation },
			});
		}
	};

	const handleDoubleClick = (e: MouseEvent, id: string) => {
		e.stopPropagation();
		const ann = annotations.find((a) => a.id === id);
		if (ann && ann.type === "text") {
			// Snapshot for text editing
			textSnapshot = {
				project: structuredClone(unwrap(project)),
				annotations: structuredClone(unwrap(annotations)),
			};
			setTextEditingId(id);
		}
	};

	const handleSize = createMemo(() => {
		if (props.cssWidth === 0) return 0;
		return (10 / props.cssWidth) * props.bounds.width;
	});

	return (
		<svg
			viewBox={`${props.bounds.x} ${props.bounds.y} ${props.bounds.width} ${props.bounds.height}`}
			style={{
				width: `${props.cssWidth}px`,
				height: `${props.cssHeight}px`,
				position: "absolute",
				top: 0,
				left: 0,
				"pointer-events": "all",
				"z-index": 10,
			}}
			class={activeTool() !== "select" ? "cursor-crosshair" : ""}
			onMouseDown={handleMouseDown}
			onMouseMove={handleMouseMove}
			onMouseUp={handleMouseUp}
		>
			<style>{`
				.text-hover-overlay {
					transition: fill 0.15s, stroke 0.15s;
				}
				.group:hover .text-hover-overlay {
					fill: rgba(59, 130, 246, 0.05);
					stroke: rgba(59, 130, 246, 0.4);
				}
			`}</style>
			<For each={annotations}>
				{(ann) => (
					<g
						onMouseDown={(e) => startDrag(e, ann.id)}
						onDblClick={(e) => handleDoubleClick(e, ann.id)}
						class="group"
						style={{
							"pointer-events": "all",
							cursor: activeTool() === "select" ? "move" : "inherit",
						}}
					>
						{/* Text Editor Overlay */}
						<Show when={textEditingId() === ann.id}>
							<foreignObject
								x={ann.x}
								y={ann.y}
								width={Math.max(ann.width, 100)}
								height={Math.max(ann.height, 50)}
								class="overflow-visible"
							>
								<div
									class="text-editor bg-transparent outline-none p-0 m-0"
									contentEditable
									style={{
										"font-size": `${ann.height}px`,
										color: ann.strokeColor,
										"min-width": "10px",
										"white-space": "nowrap",
										"line-height": "1",
									}}
									ref={(el) => {
										el.textContent = ann.text ?? "";
										setTimeout(() => {
											el.focus();
											const range = document.createRange();
											range.selectNodeContents(el);
											const sel = window.getSelection();
											sel?.removeAllRanges();
											sel?.addRange(range);
										});
									}}
									onInput={(e) => {
										const text = e.currentTarget.textContent ?? "";
										setAnnotations((a) => a.id === ann.id, "text", text);
									}}
									onBlur={(e) => {
										const text = e.currentTarget.textContent ?? "";

										if (!text.trim()) {
											if (textSnapshot) projectHistory.push(textSnapshot);
											setAnnotations((prev) =>
												prev.filter((a) => a.id !== ann.id),
											);
										} else if (textSnapshot) {
											const originalText = textSnapshot.annotations.find(
												(a) => a.id === ann.id,
											)?.text;
											if (text !== originalText) {
												projectHistory.push(textSnapshot);
											}
										}

										textSnapshot = null;
										setTextEditingId(null);
									}}
									onKeyDown={(e) => {
										e.stopPropagation();
										if (e.key === "Enter" && !e.shiftKey) {
											e.preventDefault();
											e.currentTarget.blur();
										}
									}}
								/>
							</foreignObject>
						</Show>

						<Show when={textEditingId() !== ann.id}>
							<RenderAnnotation annotation={ann} />
						</Show>

						{/* Text hover overlay - only shown when not selected */}
						<Show
							when={
								ann.type === "text" &&
								selectedAnnotationId() !== ann.id &&
								!textEditingId() &&
								activeTool() === "select"
							}
						>
							<rect
								x={ann.x - handleSize() * 0.3}
								y={ann.y - handleSize() * 0.3}
								width={Math.abs(ann.width) + handleSize() * 0.6}
								height={Math.abs(ann.height) + handleSize() * 0.6}
								fill="transparent"
								stroke="transparent"
								stroke-width={2}
								rx={4}
								ry={4}
								class="text-hover-overlay"
								style={{ "pointer-events": "all" }}
							/>
						</Show>

						<Show when={selectedAnnotationId() === ann.id && !textEditingId()}>
							<SelectionHandles
								annotation={ann}
								handleSize={handleSize()}
								onResizeStart={startDrag}
							/>
						</Show>
					</g>
				)}
			</For>
			<Show when={tempAnnotation()}>
				{(ann) => <RenderAnnotation annotation={ann()} />}
			</Show>
		</svg>
	);
}

function RenderAnnotation(props: { annotation: Annotation }) {
	return (
		<>
			{props.annotation.type === "rectangle" && (
				<rect
					x={Math.min(
						props.annotation.x,
						props.annotation.x + props.annotation.width,
					)}
					y={Math.min(
						props.annotation.y,
						props.annotation.y + props.annotation.height,
					)}
					width={Math.abs(props.annotation.width)}
					height={Math.abs(props.annotation.height)}
					stroke={props.annotation.strokeColor}
					stroke-width={props.annotation.strokeWidth}
					fill={props.annotation.fillColor}
					opacity={props.annotation.opacity}
				/>
			)}
			{props.annotation.type === "circle" && (
				<ellipse
					cx={props.annotation.x + props.annotation.width / 2}
					cy={props.annotation.y + props.annotation.height / 2}
					rx={Math.abs(props.annotation.width / 2)}
					ry={Math.abs(props.annotation.height / 2)}
					stroke={props.annotation.strokeColor}
					stroke-width={props.annotation.strokeWidth}
					fill={props.annotation.fillColor}
					opacity={props.annotation.opacity}
				/>
			)}
			{props.annotation.type === "arrow" &&
				(() => {
					const x1 = props.annotation.x;
					const y1 = props.annotation.y;
					const x2 = props.annotation.x + props.annotation.width;
					const y2 = props.annotation.y + props.annotation.height;
					const angle = Math.atan2(y2 - y1, x2 - x1);
					const head = getArrowHeadPoints(
						x2,
						y2,
						angle,
						props.annotation.strokeWidth,
					);
					return (
						<>
							<line
								x1={x1}
								y1={y1}
								x2={head.base.x}
								y2={head.base.y}
								stroke={props.annotation.strokeColor}
								stroke-width={props.annotation.strokeWidth}
								stroke-linecap="round"
								opacity={props.annotation.opacity}
							/>
							<polygon
								points={head.points.map((p) => `${p.x},${p.y}`).join(" ")}
								fill={props.annotation.strokeColor}
								opacity={props.annotation.opacity}
							/>
						</>
					);
				})()}
			{props.annotation.type === "text" && (
				<text
					x={props.annotation.x}
					y={props.annotation.y + props.annotation.height} // SVG text y is baseline
					fill={props.annotation.strokeColor}
					font-size={`${props.annotation.height}px`}
					font-family="sans-serif"
					opacity={props.annotation.opacity}
					style={{ "user-select": "none", "white-space": "pre" }}
				>
					{props.annotation.text}
				</text>
			)}
			{props.annotation.type === "mask" && (
				<rect
					x={Math.min(
						props.annotation.x,
						props.annotation.x + props.annotation.width,
					)}
					y={Math.min(
						props.annotation.y,
						props.annotation.y + props.annotation.height,
					)}
					width={Math.abs(props.annotation.width)}
					height={Math.abs(props.annotation.height)}
					fill="none"
					stroke="none"
					opacity={props.annotation.opacity}
					style={{ "pointer-events": "all" }}
				/>
			)}
		</>
	);
}

function SelectionHandles(props: {
	annotation: Annotation;
	handleSize: number;
	onResizeStart: (e: MouseEvent, id: string, handle: string) => void;
}) {
	const half = createMemo(() => props.handleSize / 2);

	const isText = () => props.annotation.type === "text";
	const isArrow = () => props.annotation.type === "arrow";

	const padding = createMemo(() => (isText() ? props.handleSize * 0.3 : 0));

	const selectionRect = createMemo(() => {
		const ann = props.annotation;
		const p = padding();
		return {
			x: Math.min(ann.x, ann.x + ann.width) - p,
			y: Math.min(ann.y, ann.y + ann.height) - p,
			width: Math.abs(ann.width) + p * 2,
			height: Math.abs(ann.height) + p * 2,
		};
	});

	const cornerHandles = () => {
		if (isText()) {
			return [
				{ id: "nw", x: 0, y: 0 },
				{ id: "ne", x: 1, y: 0 },
				{ id: "sw", x: 0, y: 1 },
				{ id: "se", x: 1, y: 1 },
			];
		}
		return [
			{ id: "nw", x: 0, y: 0 },
			{ id: "n", x: 0.5, y: 0 },
			{ id: "ne", x: 1, y: 0 },
			{ id: "w", x: 0, y: 0.5 },
			{ id: "e", x: 1, y: 0.5 },
			{ id: "sw", x: 0, y: 1 },
			{ id: "s", x: 0.5, y: 1 },
			{ id: "se", x: 1, y: 1 },
		];
	};

	return (
		<Show
			when={!isArrow()}
			fallback={
				<g>
					<Handle
						cx={props.annotation.x}
						cy={props.annotation.y}
						r={half()}
						cursor="crosshair"
						isText={false}
						onMouseDown={(e) =>
							props.onResizeStart(e, props.annotation.id, "start")
						}
					/>
					<Handle
						cx={props.annotation.x + props.annotation.width}
						cy={props.annotation.y + props.annotation.height}
						r={half()}
						cursor="crosshair"
						isText={false}
						onMouseDown={(e) =>
							props.onResizeStart(e, props.annotation.id, "end")
						}
					/>
				</g>
			}
		>
			<g>
				<Show when={isText()}>
					<rect
						x={selectionRect().x}
						y={selectionRect().y}
						width={selectionRect().width}
						height={selectionRect().height}
						fill="rgba(59, 130, 246, 0.1)"
						stroke="#3b82f6"
						stroke-width={2}
						rx={4}
						ry={4}
						style={{ "pointer-events": "none" }}
					/>
				</Show>
				<For each={cornerHandles()}>
					{(handle) => (
						<Handle
							cx={selectionRect().x + handle.x * selectionRect().width}
							cy={selectionRect().y + handle.y * selectionRect().height}
							r={half()}
							cursor={`${handle.id}-resize`}
							isText={isText()}
							onMouseDown={(e) =>
								props.onResizeStart(e, props.annotation.id, handle.id)
							}
						/>
					)}
				</For>
			</g>
		</Show>
	);
}

function Handle(props: {
	cx: number;
	cy: number;
	r: number;
	cursor: string;
	isText: boolean;
	onMouseDown: (e: MouseEvent) => void;
}) {
	return (
		<circle
			cx={props.cx}
			cy={props.cy}
			r={props.r}
			fill={props.isText ? "#3b82f6" : "white"}
			stroke={props.isText ? "white" : "#3b82f6"}
			stroke-width={props.isText ? 1.5 : 1}
			class="cursor-pointer"
			style={{
				"pointer-events": "all",
				cursor: props.cursor,
			}}
			onMouseDown={props.onMouseDown}
		/>
	);
}
