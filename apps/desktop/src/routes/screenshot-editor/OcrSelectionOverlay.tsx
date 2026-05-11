import { invoke } from "@tauri-apps/api/core";
import { createEffect, createSignal, Show } from "solid-js";
import toast from "solid-toast";
import { commands } from "~/utils/tauri";
import { type ScreenshotProject, useScreenshotEditorContext } from "./context";

type Rect = {
	x: number;
	y: number;
	width: number;
	height: number;
};

type Point = {
	x: number;
	y: number;
};

type ScreenshotOcrRegion = {
	x: number;
	y: number;
	width: number;
	height: number;
};

type ScreenshotOcrResult = {
	text: string;
	lines: {
		text: string;
		confidence: number | null;
		bounds: ScreenshotOcrRegion;
	}[];
	engine: string;
};

export function OcrSelectionOverlay(props: {
	bounds: Rect;
	cssWidth: number;
	cssHeight: number;
	imageRect: Rect;
	originalImageSize: { width: number; height: number } | null;
	crop: ScreenshotProject["background"]["crop"];
}) {
	const { activeTool, setActiveTool, setSelectedAnnotationId } =
		useScreenshotEditorContext();
	const [drag, setDrag] = createSignal<{
		pointerId: number;
		start: Point;
		current: Point;
	} | null>(null);
	const [selection, setSelection] = createSignal<Rect | null>(null);
	const [isRecognizing, setIsRecognizing] = createSignal(false);

	createEffect(() => {
		if (activeTool() !== "ocr") {
			setDrag(null);
			setSelection(null);
			setIsRecognizing(false);
		}
	});

	const clamp = (value: number, min: number, max: number) =>
		Math.min(Math.max(value, min), max);

	const getSvgPoint = (e: PointerEvent, svg: SVGSVGElement): Point => {
		const rect = svg.getBoundingClientRect();
		return {
			x:
				props.bounds.x +
				((e.clientX - rect.left) / rect.width) * props.bounds.width,
			y:
				props.bounds.y +
				((e.clientY - rect.top) / rect.height) * props.bounds.height,
		};
	};

	const clampToImage = (point: Point): Point => ({
		x: clamp(
			point.x,
			props.imageRect.x,
			props.imageRect.x + props.imageRect.width,
		),
		y: clamp(
			point.y,
			props.imageRect.y,
			props.imageRect.y + props.imageRect.height,
		),
	});

	const rectFromPoints = (start: Point, current: Point): Rect => {
		const x = Math.min(start.x, current.x);
		const y = Math.min(start.y, current.y);
		return {
			x,
			y,
			width: Math.max(start.x, current.x) - x,
			height: Math.max(start.y, current.y) - y,
		};
	};

	const mapSelectionToSource = (rect: Rect): ScreenshotOcrRegion | null => {
		const original = props.originalImageSize;
		if (!original || original.width <= 0 || original.height <= 0) return null;
		if (props.imageRect.width <= 0 || props.imageRect.height <= 0) return null;

		const crop = props.crop ?? {
			position: { x: 0, y: 0 },
			size: { x: original.width, y: original.height },
		};
		const leftRatio = clamp(
			(rect.x - props.imageRect.x) / props.imageRect.width,
			0,
			1,
		);
		const topRatio = clamp(
			(rect.y - props.imageRect.y) / props.imageRect.height,
			0,
			1,
		);
		const rightRatio = clamp(
			(rect.x + rect.width - props.imageRect.x) / props.imageRect.width,
			0,
			1,
		);
		const bottomRatio = clamp(
			(rect.y + rect.height - props.imageRect.y) / props.imageRect.height,
			0,
			1,
		);
		const left = crop.position.x + leftRatio * crop.size.x;
		const top = crop.position.y + topRatio * crop.size.y;
		const right = crop.position.x + rightRatio * crop.size.x;
		const bottom = crop.position.y + bottomRatio * crop.size.y;
		const x = clamp(Math.floor(left), 0, original.width - 1);
		const y = clamp(Math.floor(top), 0, original.height - 1);
		const sourceRight = clamp(Math.ceil(right), x + 1, original.width);
		const sourceBottom = clamp(Math.ceil(bottom), y + 1, original.height);

		return {
			x,
			y,
			width: sourceRight - x,
			height: sourceBottom - y,
		};
	};

	const recognizeSelection = async (region: ScreenshotOcrRegion) => {
		setIsRecognizing(true);
		try {
			const result = await invoke<ScreenshotOcrResult>(
				"recognize_screenshot_text",
				{ region },
			);
			const text = result.text.trim();
			if (!text) {
				toast.error("No text found");
				return;
			}
			await commands.writeClipboardString(text);
			toast.success("Text copied to clipboard");
			setActiveTool("select");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		} finally {
			setIsRecognizing(false);
			setSelection(null);
		}
	};

	const handlePointerDown = (e: PointerEvent) => {
		if (activeTool() !== "ocr" || isRecognizing() || e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		setSelectedAnnotationId(null);
		const svg = e.currentTarget as SVGSVGElement;
		svg.setPointerCapture(e.pointerId);
		const point = clampToImage(getSvgPoint(e, svg));
		setDrag({ pointerId: e.pointerId, start: point, current: point });
		setSelection({ x: point.x, y: point.y, width: 0, height: 0 });
	};

	const handlePointerMove = (e: PointerEvent) => {
		const currentDrag = drag();
		if (!currentDrag || currentDrag.pointerId !== e.pointerId) return;
		e.preventDefault();
		e.stopPropagation();
		const svg = e.currentTarget as SVGSVGElement;
		const point = clampToImage(getSvgPoint(e, svg));
		const nextDrag = { ...currentDrag, current: point };
		setDrag(nextDrag);
		setSelection(rectFromPoints(nextDrag.start, nextDrag.current));
	};

	const finishPointer = (e: PointerEvent) => {
		const currentDrag = drag();
		if (!currentDrag || currentDrag.pointerId !== e.pointerId) return;
		e.preventDefault();
		e.stopPropagation();
		const svg = e.currentTarget as SVGSVGElement;
		if (svg.hasPointerCapture(e.pointerId)) {
			svg.releasePointerCapture(e.pointerId);
		}
		setDrag(null);
		const rect = selection();
		if (!rect || rect.width < 8 || rect.height < 8) {
			setSelection(null);
			toast.error("Select a larger text area");
			return;
		}
		const region = mapSelectionToSource(rect);
		if (!region || region.width < 4 || region.height < 4) {
			setSelection(null);
			toast.error("Select a larger text area");
			return;
		}
		void recognizeSelection(region);
	};

	const cancelPointer = (e: PointerEvent) => {
		const currentDrag = drag();
		if (!currentDrag || currentDrag.pointerId !== e.pointerId) return;
		e.preventDefault();
		e.stopPropagation();
		setDrag(null);
		setSelection(null);
	};

	return (
		<Show when={activeTool() === "ocr"}>
			<svg
				viewBox={`${props.bounds.x} ${props.bounds.y} ${props.bounds.width} ${props.bounds.height}`}
				style={{
					width: `${props.cssWidth}px`,
					height: `${props.cssHeight}px`,
					position: "absolute",
					top: 0,
					left: 0,
					"pointer-events": "all",
					"z-index": 20,
					cursor: isRecognizing() ? "progress" : "crosshair",
				}}
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={finishPointer}
				onPointerCancel={cancelPointer}
			>
				<rect
					x={props.imageRect.x}
					y={props.imageRect.y}
					width={props.imageRect.width}
					height={props.imageRect.height}
					fill="rgba(59, 130, 246, 0.05)"
					stroke="rgba(59, 130, 246, 0.35)"
					stroke-width={Math.max(
						1,
						props.bounds.width / Math.max(props.cssWidth, 1),
					)}
					pointer-events="none"
				/>
				<Show when={selection()}>
					{(rect) => (
						<rect
							x={rect().x}
							y={rect().y}
							width={rect().width}
							height={rect().height}
							fill="rgba(59, 130, 246, 0.16)"
							stroke="rgba(37, 99, 235, 0.9)"
							stroke-width={Math.max(
								2,
								props.bounds.width / Math.max(props.cssWidth, 1),
							)}
							pointer-events="none"
						/>
					)}
				</Show>
			</svg>
		</Show>
	);
}
