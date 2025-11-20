import { convertFileSrc } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { createSignal } from "solid-js";
import toast from "solid-toast";
import { commands } from "~/utils/tauri";
import { type Annotation, useScreenshotEditorContext } from "./context";

export function useScreenshotExport() {
	const { path, latestFrame, annotations } = useScreenshotEditorContext();
	const [isExporting, setIsExporting] = createSignal(false);

	const drawAnnotations = (
		ctx: CanvasRenderingContext2D,
		annotations: Annotation[],
	) => {
		for (const ann of annotations) {
			if (ann.type === "mask") continue;
			ctx.save();
			ctx.globalAlpha = ann.opacity;
			ctx.strokeStyle = ann.strokeColor;
			ctx.lineWidth = ann.strokeWidth;
			ctx.fillStyle = ann.fillColor;

			if (ann.type === "rectangle") {
				if (ann.fillColor !== "transparent") {
					ctx.fillRect(ann.x, ann.y, ann.width, ann.height);
				}
				ctx.strokeRect(ann.x, ann.y, ann.width, ann.height);
			} else if (ann.type === "circle") {
				ctx.beginPath();
				const cx = ann.x + ann.width / 2;
				const cy = ann.y + ann.height / 2;
				const rx = Math.abs(ann.width / 2);
				const ry = Math.abs(ann.height / 2);
				ctx.ellipse(cx, cy, rx, ry, 0, 0, 2 * Math.PI);
				if (ann.fillColor !== "transparent") {
					ctx.fill();
				}
				ctx.stroke();
			} else if (ann.type === "arrow") {
				ctx.beginPath();
				const x1 = ann.x;
				const y1 = ann.y;
				const x2 = ann.x + ann.width;
				const y2 = ann.y + ann.height;

				// Line
				ctx.moveTo(x1, y1);
				ctx.lineTo(x2, y2);
				ctx.stroke();

				// Arrowhead
				const angle = Math.atan2(y2 - y1, x2 - x1);
				const headLen = 10 + ann.strokeWidth; // scale with stroke?
				ctx.beginPath();
				ctx.moveTo(x2, y2);
				ctx.lineTo(
					x2 - headLen * Math.cos(angle - Math.PI / 6),
					y2 - headLen * Math.sin(angle - Math.PI / 6),
				);
				ctx.lineTo(
					x2 - headLen * Math.cos(angle + Math.PI / 6),
					y2 - headLen * Math.sin(angle + Math.PI / 6),
				);
				ctx.lineTo(x2, y2);
				ctx.fillStyle = ann.strokeColor;
				ctx.fill();
			} else if (ann.type === "text" && ann.text) {
				ctx.fillStyle = ann.strokeColor; // Text uses stroke color
				ctx.font = `${ann.height}px sans-serif`;
				ctx.fillText(ann.text, ann.x, ann.y + ann.height); // text baseline bottomish
			}

			ctx.restore();
		}
	};

	const blurRegion = (
		ctx: CanvasRenderingContext2D,
		source: HTMLCanvasElement,
		startX: number,
		startY: number,
		regionWidth: number,
		regionHeight: number,
		level: number,
	) => {
		const scale = Math.max(2, Math.round(level / 4));
		const temp = document.createElement("canvas");
		temp.width = Math.max(1, Math.floor(regionWidth / scale));
		temp.height = Math.max(1, Math.floor(regionHeight / scale));
		const tempCtx = temp.getContext("2d");
		if (!tempCtx) return;

		tempCtx.imageSmoothingEnabled = true;
		tempCtx.drawImage(
			source,
			startX,
			startY,
			regionWidth,
			regionHeight,
			0,
			0,
			temp.width,
			temp.height,
		);

		ctx.drawImage(
			temp,
			0,
			0,
			temp.width,
			temp.height,
			startX,
			startY,
			regionWidth,
			regionHeight,
		);
	};

	const applyMaskAnnotations = (
		ctx: CanvasRenderingContext2D,
		source: HTMLCanvasElement,
		annotations: Annotation[],
	) => {
		for (const ann of annotations) {
			if (ann.type !== "mask") continue;

			const startX = Math.max(0, Math.min(ann.x, ann.x + ann.width));
			const startY = Math.max(0, Math.min(ann.y, ann.y + ann.height));
			const endX = Math.min(source.width, Math.max(ann.x, ann.x + ann.width));
			const endY = Math.min(source.height, Math.max(ann.y, ann.y + ann.height));

			const regionWidth = endX - startX;
			const regionHeight = endY - startY;
			if (regionWidth <= 0 || regionHeight <= 0) continue;

			const level = Math.max(1, ann.maskLevel ?? 16);
			const type = ann.maskType ?? "blur";

			if (type === "pixelate") {
				const blockSize = Math.max(2, Math.round(level));
				const temp = document.createElement("canvas");
				temp.width = Math.max(1, Math.floor(regionWidth / blockSize));
				temp.height = Math.max(1, Math.floor(regionHeight / blockSize));
				const tempCtx = temp.getContext("2d");
				if (!tempCtx) continue;
				tempCtx.imageSmoothingEnabled = false;
				tempCtx.drawImage(
					source,
					startX,
					startY,
					regionWidth,
					regionHeight,
					0,
					0,
					temp.width,
					temp.height,
				);
				const previousSmoothing = ctx.imageSmoothingEnabled;
				ctx.imageSmoothingEnabled = false;
				ctx.drawImage(
					temp,
					0,
					0,
					temp.width,
					temp.height,
					startX,
					startY,
					regionWidth,
					regionHeight,
				);
				ctx.imageSmoothingEnabled = previousSmoothing;
				continue;
			}

			blurRegion(ctx, source, startX, startY, regionWidth, regionHeight, level);
		}
		ctx.filter = "none";
	};

	const exportImage = async (destination: "file" | "clipboard") => {
		setIsExporting(true);
		try {
			const canvas = document.createElement("canvas");
			const ctx = canvas.getContext("2d");
			if (!ctx) throw new Error("Could not get canvas context");

			const frame = latestFrame();
			if (frame) {
				canvas.width = frame.width;
				canvas.height = frame.data.height;
				ctx.putImageData(frame.data, 0, 0);
			} else {
				// Fallback to loading file
				const img = new Image();
				img.src = convertFileSrc(path);
				await new Promise((resolve, reject) => {
					img.onload = resolve;
					img.onerror = reject;
				});
				canvas.width = img.width;
				canvas.height = img.height;
				ctx.drawImage(img, 0, 0);
			}

			const sourceCanvas = document.createElement("canvas");
			sourceCanvas.width = canvas.width;
			sourceCanvas.height = canvas.height;
			const sourceCtx = sourceCanvas.getContext("2d");
			if (!sourceCtx) throw new Error("Could not get source canvas context");
			sourceCtx.drawImage(canvas, 0, 0);

			applyMaskAnnotations(ctx, sourceCanvas, annotations);
			drawAnnotations(ctx, annotations);

			const blob = await new Promise<Blob | null>((resolve) =>
				canvas.toBlob(resolve, "image/png"),
			);
			if (!blob) throw new Error("Failed to create blob");

			const buffer = await blob.arrayBuffer();
			const uint8Array = new Uint8Array(buffer);

			if (destination === "file") {
				const savePath = await save({
					filters: [{ name: "PNG Image", extensions: ["png"] }],
					defaultPath: "screenshot.png",
				});
				if (savePath) {
					await commands.writeFile(savePath, Array.from(uint8Array));
					toast.success("Screenshot saved!");
					setDialog({ ...dialog(), open: false });
				}
			} else {
				// Use the new copyImageToClipboard command
				// @ts-ignore - commands type might not be updated yet
				await commands.copyImageToClipboard(Array.from(uint8Array));
				toast.success("Screenshot copied to clipboard!");
				setDialog({ ...dialog(), open: false });
			}
		} catch (err) {
			console.error(err);
			toast.error("Failed to export");
		} finally {
			setIsExporting(false);
		}
	};

	return { exportImage, isExporting };
}
