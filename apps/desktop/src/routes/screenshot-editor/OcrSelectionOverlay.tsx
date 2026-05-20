import { invoke } from "@tauri-apps/api/core";
import { createEffect, createMemo, createSignal, For } from "solid-js";
import { type ScreenshotProject, useScreenshotEditorContext } from "./context";

type Rect = {
	x: number;
	y: number;
	width: number;
	height: number;
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

type TextLayout = {
	text: string;
	rect: Rect;
	fontSize: number;
	lineHeight: number;
	textWidth: number;
	scaleX: number;
};

const fontFamily =
	'-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

export function OcrSelectionOverlay(props: {
	bounds: Rect;
	cssWidth: number;
	cssHeight: number;
	imageRect: Rect;
	originalImageSize: { width: number; height: number } | null;
	crop: ScreenshotProject["background"]["crop"];
}) {
	const { activeTool, setSelectedAnnotationId } = useScreenshotEditorContext();
	const [ocrResult, setOcrResult] = createSignal<ScreenshotOcrResult | null>(
		null,
	);
	let requestId = 0;
	let measureCanvas: HTMLCanvasElement | null = null;

	const clamp = (value: number, min: number, max: number) =>
		Math.min(Math.max(value, min), max);

	const sourceRegion = createMemo<ScreenshotOcrRegion | null>(() => {
		const original = props.originalImageSize;
		if (!original || original.width <= 0 || original.height <= 0) return null;
		const crop = props.crop ?? {
			position: { x: 0, y: 0 },
			size: { x: original.width, y: original.height },
		};
		const left = clamp(crop.position.x, 0, original.width);
		const top = clamp(crop.position.y, 0, original.height);
		const right = clamp(crop.position.x + crop.size.x, left, original.width);
		const bottom = clamp(crop.position.y + crop.size.y, top, original.height);
		const x = Math.floor(left);
		const y = Math.floor(top);
		const sourceRight = Math.ceil(right);
		const sourceBottom = Math.ceil(bottom);
		const width = sourceRight - x;
		const height = sourceBottom - y;
		if (width < 4 || height < 4) return null;
		return { x, y, width, height };
	});

	const sourceRegionKey = createMemo(() => {
		const region = sourceRegion();
		if (!region) return null;
		return `${region.x}:${region.y}:${region.width}:${region.height}`;
	});

	createEffect(() => {
		const key = sourceRegionKey();
		const region = sourceRegion();
		requestId += 1;
		const currentRequestId = requestId;

		if (!key || !region) {
			setOcrResult(null);
			return;
		}

		setOcrResult(null);

		void (async () => {
			try {
				const result = await invoke<ScreenshotOcrResult>(
					"recognize_screenshot_text",
					{ region },
				);
				if (currentRequestId !== requestId) return;
				setOcrResult(result);
			} catch {
				if (currentRequestId !== requestId) return;
				setOcrResult(null);
			}
		})();
	});

	const sourceToCssRect = (rect: ScreenshotOcrRegion): Rect | null => {
		const region = sourceRegion();
		if (!region) return null;
		if (props.bounds.width <= 0 || props.bounds.height <= 0) return null;
		if (props.imageRect.width <= 0 || props.imageRect.height <= 0) return null;
		const regionRight = region.x + region.width;
		const regionBottom = region.y + region.height;
		const left = clamp(rect.x, region.x, regionRight);
		const top = clamp(rect.y, region.y, regionBottom);
		const right = clamp(rect.x + rect.width, left, regionRight);
		const bottom = clamp(rect.y + rect.height, top, regionBottom);
		const frameRect = {
			x:
				props.imageRect.x +
				((left - region.x) / region.width) * props.imageRect.width,
			y:
				props.imageRect.y +
				((top - region.y) / region.height) * props.imageRect.height,
			width: ((right - left) / region.width) * props.imageRect.width,
			height: ((bottom - top) / region.height) * props.imageRect.height,
		};
		if (frameRect.width <= 0 || frameRect.height <= 0) return null;
		return {
			x: ((frameRect.x - props.bounds.x) / props.bounds.width) * props.cssWidth,
			y:
				((frameRect.y - props.bounds.y) / props.bounds.height) *
				props.cssHeight,
			width: (frameRect.width / props.bounds.width) * props.cssWidth,
			height: (frameRect.height / props.bounds.height) * props.cssHeight,
		};
	};

	const measureText = (text: string, fontSize: number) => {
		if (typeof document === "undefined") {
			return Math.max(text.length * fontSize * 0.55, 1);
		}
		measureCanvas ??= document.createElement("canvas");
		const ctx = measureCanvas.getContext("2d");
		if (!ctx) return Math.max(text.length * fontSize * 0.55, 1);
		ctx.font = `${fontSize}px ${fontFamily}`;
		return Math.max(ctx.measureText(text).width, 1);
	};

	const textLayouts = createMemo<TextLayout[]>(() => {
		const result = ocrResult();
		if (!result) return [];
		return result.lines.flatMap((line) => {
			const text = line.text;
			const rect = sourceToCssRect(line.bounds);
			if (!text.trim() || !rect) return [];
			const lineHeight = Math.max(rect.height, 1);
			const fontSize = Math.max(lineHeight * 0.78, 1);
			const textWidth = measureText(text, fontSize);
			const scaleX = rect.width / textWidth;
			return [
				{
					text,
					rect,
					fontSize,
					lineHeight,
					textWidth,
					scaleX,
				},
			];
		});
	});

	return (
		<div
			style={{
				width: `${props.cssWidth}px`,
				height: `${props.cssHeight}px`,
				position: "absolute",
				top: 0,
				left: 0,
				"pointer-events": "none",
				"z-index": 15,
				overflow: "visible",
			}}
		>
			<For each={textLayouts()}>
				{(layout) => (
					<span
						style={{
							position: "absolute",
							display: "block",
							left: `${layout.rect.x}px`,
							top: `${layout.rect.y}px`,
							width: `${layout.textWidth}px`,
							height: `${layout.lineHeight}px`,
							"font-family": fontFamily,
							"font-size": `${layout.fontSize}px`,
							"line-height": `${layout.lineHeight}px`,
							"letter-spacing": "0",
							"white-space": "pre",
							color: "transparent",
							"caret-color": "transparent",
							overflow: "visible",
							"pointer-events": activeTool() === "select" ? "auto" : "none",
							"user-select": "text",
							"-webkit-user-select": "text",
							cursor: "text",
							transform: `scaleX(${layout.scaleX})`,
							"transform-origin": "left top",
						}}
						onMouseDown={() => setSelectedAnnotationId(null)}
					>
						{layout.text}
					</span>
				)}
			</For>
		</div>
	);
}
