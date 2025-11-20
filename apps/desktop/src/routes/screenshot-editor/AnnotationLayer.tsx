import { cx } from "cva";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	onCleanup,
	Show,
} from "solid-js";
import { unwrap } from "solid-js/store";
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

		if (activeTool() === "select") {
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

		setIsDrawing(true);
		const id = crypto.randomUUID();
		const newAnn: Annotation = {
			id,
			type: activeTool() as AnnotationType,
			x: point.x,
			y: point.y,
			width: 0,
			height: 0,
			strokeColor: "#F05656", // Red default
			strokeWidth: 4,
			fillColor: "transparent",
			opacity: 1,
			rotation: 0,
			text: activeTool() === "text" ? "Text" : null,
			maskType: activeTool() === "mask" ? "blur" : null,
			maskLevel: activeTool() === "mask" ? 16 : null,
		};

		if (activeTool() === "text") {
			newAnn.height = 40; // Default font size
			newAnn.width = 150; // Default width
		}

		setTempAnnotation(newAnn);
	};

	const handleMouseMove = (e: MouseEvent) => {
		const svg = e.currentTarget as SVGSVGElement;
		const point = getSvgPoint(e, svg);

		if (isDrawing() && tempAnnotation()) {
			const temp = tempAnnotation()!;
			// Update temp annotation dimensions
			if (temp.type === "text") return;

			let width = point.x - temp.x;
			let height = point.y - temp.y;

			// Shift key for aspect ratio constraint
			if (e.shiftKey) {
				if (
					temp.type === "rectangle" ||
					temp.type === "circle" ||
					temp.type === "mask"
				) {
					const size = Math.max(Math.abs(width), Math.abs(height));
					width = width < 0 ? -size : size;
					height = height < 0 ? -size : size;
				} else if (temp.type === "arrow") {
					// Snap to 45 degree increments
					const angle = Math.atan2(height, width);
					const snap = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
					const dist = Math.sqrt(width * width + height * height);
					width = Math.cos(snap) * dist;
					height = Math.sin(snap) * dist;
				}
			}

			setTempAnnotation({
				...temp,
				width,
				height,
			});
			return;
		}

		if (dragState()) {
			const state = dragState()!;
			const dx = point.x - state.startX;
			const dy = point.y - state.startY;

			if (state.action === "move") {
				setAnnotations(
					(a) => a.id === state.id,
					(a) => ({
						...a,
						x: state.original.x + dx,
						y: state.original.y + dy,
					}),
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

					// Shift constraint during resize
					if (
						e.shiftKey &&
						(original.type === "rectangle" || original.type === "circle")
					) {
						// This is complex for corner resizing, simplifying:
						// Just force aspect ratio based on original
						const ratio = original.width / original.height;
						if (state.handle.includes("e") || state.handle.includes("w")) {
							// Width driven, adjust height
							// This is tricky with 8 handles. Skipping proper aspect resize for now to save time/complexity
							// Or simple implementation:
						}
					}
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
		if (isDrawing() && tempAnnotation()) {
			const ann = tempAnnotation()!;
			// Normalize rect/circle negative width/height
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
				if (ann.width < 5 && ann.height < 5) {
					setTempAnnotation(null);
					setIsDrawing(false);
					drawSnapshot = null; // Cancel snapshot if too small
					return;
				}
			}
			// For arrow, we keep negative width/height as vector

			// Commit history
			if (drawSnapshot) projectHistory.push(drawSnapshot);
			drawSnapshot = null;

			setAnnotations((prev) => [...prev, ann]);
			setTempAnnotation(null);
			setIsDrawing(false);
			setActiveTool("select");
			setSelectedAnnotationId(ann.id);
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

		const svg = (e.currentTarget as Element).closest("svg")!;
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
			<defs>
				<marker
					id="arrowhead"
					markerWidth="10"
					markerHeight="7"
					refX="9"
					refY="3.5"
					orient="auto"
				>
					<polygon points="0 0, 10 3.5, 0 7" fill="context-stroke" />
				</marker>
			</defs>

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
										setTimeout(() => {
											el.focus();
											// Select all text
											const range = document.createRange();
											range.selectNodeContents(el);
											const sel = window.getSelection();
											sel?.removeAllRanges();
											sel?.addRange(range);
										});
									}}
									onBlur={(e) => {
										const text = e.currentTarget.innerText;
										const originalText = annotations.find(
											(a) => a.id === ann.id,
										)?.text;

										if (!text.trim()) {
											// If deleting, use snapshot
											if (textSnapshot) projectHistory.push(textSnapshot);
											setAnnotations((prev) =>
												prev.filter((a) => a.id !== ann.id),
											);
										} else if (text !== originalText) {
											// If changed, use snapshot
											if (textSnapshot) projectHistory.push(textSnapshot);
											setAnnotations((a) => a.id === ann.id, "text", text);
										}

										textSnapshot = null;
										setTextEditingId(null);
									}}
									onKeyDown={(e) => {
										e.stopPropagation(); // Prevent deleting annotation
										if (e.key === "Enter" && !e.shiftKey) {
											e.preventDefault();
											e.currentTarget.blur();
										}
									}}
								>
									{ann.text}
								</div>
							</foreignObject>
						</Show>

						<Show when={textEditingId() !== ann.id}>
							<RenderAnnotation annotation={ann} />
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
			{props.annotation.type === "arrow" && (
				<line
					x1={props.annotation.x}
					y1={props.annotation.y}
					x2={props.annotation.x + props.annotation.width}
					y2={props.annotation.y + props.annotation.height}
					stroke={props.annotation.strokeColor}
					stroke-width={props.annotation.strokeWidth}
					marker-end="url(#arrowhead)"
					opacity={props.annotation.opacity}
				/>
			)}
			{props.annotation.type === "text" && (
				<text
					x={props.annotation.x}
					y={props.annotation.y + props.annotation.height} // SVG text y is baseline
					fill={props.annotation.strokeColor}
					font-size={props.annotation.height}
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
					stroke={props.annotation.strokeColor}
					stroke-width={props.annotation.strokeWidth}
					fill={props.annotation.fillColor}
					opacity={props.annotation.opacity}
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

	return (
		<Show
			when={props.annotation.type === "arrow"}
			fallback={
				<g>
					<For
						each={[
							{ id: "nw", x: 0, y: 0 },
							{ id: "n", x: 0.5, y: 0 },
							{ id: "ne", x: 1, y: 0 },
							{ id: "w", x: 0, y: 0.5 },
							{ id: "e", x: 1, y: 0.5 },
							{ id: "sw", x: 0, y: 1 },
							{ id: "s", x: 0.5, y: 1 },
							{ id: "se", x: 1, y: 1 },
						]}
					>
						{(handle) => (
							<Handle
								x={
									props.annotation.x +
									handle.x * props.annotation.width -
									half()
								}
								y={
									props.annotation.y +
									handle.y * props.annotation.height -
									half()
								}
								size={props.handleSize}
								cursor={`${handle.id}-resize`}
								onMouseDown={(e) =>
									props.onResizeStart(e, props.annotation.id, handle.id)
								}
							/>
						)}
					</For>
				</g>
			}
		>
			<g>
				<Handle
					x={props.annotation.x - half()}
					y={props.annotation.y - half()}
					size={props.handleSize}
					cursor="crosshair"
					onMouseDown={(e) =>
						props.onResizeStart(e, props.annotation.id, "start")
					}
				/>
				<Handle
					x={props.annotation.x + props.annotation.width - half()}
					y={props.annotation.y + props.annotation.height - half()}
					size={props.handleSize}
					cursor="crosshair"
					onMouseDown={(e) =>
						props.onResizeStart(e, props.annotation.id, "end")
					}
				/>
			</g>
		</Show>
	);
}

function Handle(props: {
	x: number;
	y: number;
	size: number;
	cursor: string;
	onMouseDown: (e: MouseEvent) => void;
}) {
	return (
		<rect
			x={props.x}
			y={props.y}
			width={props.size}
			height={props.size}
			fill="white"
			stroke="#00A0FF"
			stroke-width={1}
			class="cursor-pointer"
			style={{
				"pointer-events": "all",
				cursor: props.cursor,
			}}
			onMouseDown={props.onMouseDown}
		/>
	);
}
