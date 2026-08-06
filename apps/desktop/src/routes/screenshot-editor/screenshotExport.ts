import type {
	Annotation,
	ProjectConfiguration,
	UploadResult,
} from "~/utils/tauri";
import { commands } from "~/utils/tauri";
import { getArrowHeadPoints } from "./arrow";

export type ScreenshotExportStatus =
	| "idle"
	| "rendering"
	| "encoding"
	| "uploading";

const hasNoVisibleBackground = (source: {
	type: string;
	path?: string | null;
	alpha?: number;
}) => {
	if (source.type === "color") {
		return (source.alpha ?? 255) === 0;
	}
	if (source.type === "wallpaper" || source.type === "image") {
		return !source.path;
	}
	return false;
};

export function screenshotShareStatusText(status: ScreenshotExportStatus) {
	switch (status) {
		case "rendering":
			return "Rendering screenshot";
		case "encoding":
			return "Preparing upload";
		case "uploading":
			return "Uploading screenshot";
		default:
			return "Create shareable link";
	}
}

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
			ctx.lineCap = "round";
			const x1 = ann.x;
			const y1 = ann.y;
			const x2 = ann.x + ann.width;
			const y2 = ann.y + ann.height;
			const angle = Math.atan2(y2 - y1, x2 - x1);
			const head = getArrowHeadPoints(x2, y2, angle, ann.strokeWidth);

			ctx.moveTo(x1, y1);
			ctx.lineTo(head.base.x, head.base.y);
			ctx.stroke();

			ctx.beginPath();
			ctx.moveTo(head.points[0].x, head.points[0].y);
			ctx.lineTo(head.points[1].x, head.points[1].y);
			ctx.lineTo(head.points[2].x, head.points[2].y);
			ctx.closePath();
			ctx.fillStyle = ann.strokeColor;
			ctx.fill();
		} else if (ann.type === "text" && ann.text) {
			ctx.fillStyle = ann.strokeColor;
			ctx.font = `${ann.height}px sans-serif`;
			ctx.fillText(ann.text, ann.x, ann.y + ann.height);
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
	imageRect: { x: number; y: number; width: number; height: number },
) => {
	for (const ann of annotations) {
		if (ann.type !== "mask") continue;

		const rectLeft = imageRect.x;
		const rectTop = imageRect.y;
		const rectRight = imageRect.x + imageRect.width;
		const rectBottom = imageRect.y + imageRect.height;

		const startX = Math.max(rectLeft, Math.min(ann.x, ann.x + ann.width));
		const startY = Math.max(rectTop, Math.min(ann.y, ann.y + ann.height));
		const endX = Math.min(rectRight, Math.max(ann.x, ann.x + ann.width));
		const endY = Math.min(rectBottom, Math.max(ann.y, ann.y + ann.height));

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

const scaleAnnotations = (
	annotations: Annotation[],
	scaleX: number,
	scaleY: number,
) => {
	const scalar = (scaleX + scaleY) / 2;

	return annotations.map((ann) => ({
		...ann,
		x: ann.x * scaleX,
		y: ann.y * scaleY,
		width: ann.width * scaleX,
		height: ann.height * scaleY,
		strokeWidth: ann.strokeWidth * scalar,
		maskLevel: ann.maskLevel == null ? ann.maskLevel : ann.maskLevel * scalar,
	}));
};

export function renderScreenshotExportCanvas({
	renderedBitmap,
	project,
	annotations,
	frame,
	previewCanvas,
	previewMaskCanvas,
	canReusePreviewCanvases,
}: {
	renderedBitmap: ImageBitmap;
	project: ProjectConfiguration;
	annotations: Annotation[];
	frame?: { width: number; height: number } | null;
	previewCanvas?: HTMLCanvasElement | null;
	previewMaskCanvas?: HTMLCanvasElement | null;
	canReusePreviewCanvases?: boolean;
}) {
	const canvas = document.createElement("canvas");
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Could not get canvas context");

	canvas.width = renderedBitmap.width;
	canvas.height = renderedBitmap.height;
	const scaleX = frame ? canvas.width / frame.width : 1;
	const scaleY = frame ? canvas.height / frame.height : 1;
	const scaledAnnotations = scaleAnnotations(annotations, scaleX, scaleY);

	if (canReusePreviewCanvases && previewCanvas && previewMaskCanvas) {
		ctx.drawImage(previewCanvas, 0, 0);
		ctx.drawImage(previewMaskCanvas, 0, 0);
	} else {
		ctx.drawImage(renderedBitmap, 0, 0);

		const sourceCanvas = document.createElement("canvas");
		sourceCanvas.width = canvas.width;
		sourceCanvas.height = canvas.height;
		const sourceCtx = sourceCanvas.getContext("2d");
		if (!sourceCtx) throw new Error("Could not get source canvas context");
		sourceCtx.drawImage(canvas, 0, 0);

		applyMaskAnnotations(ctx, sourceCanvas, scaledAnnotations, {
			x: 0,
			y: 0,
			width: canvas.width,
			height: canvas.height,
		});
	}

	const imageRect = {
		x: 0,
		y: 0,
		width: canvas.width,
		height: canvas.height,
	};

	drawAnnotations(ctx, scaledAnnotations);

	let minX = imageRect.x;
	let minY = imageRect.y;
	let maxX = imageRect.x + imageRect.width;
	let maxY = imageRect.y + imageRect.height;

	for (const ann of scaledAnnotations) {
		if (ann.type === "mask") continue;
		const left = Math.min(ann.x, ann.x + ann.width);
		const right = Math.max(ann.x, ann.x + ann.width);
		const top = Math.min(ann.y, ann.y + ann.height);
		const bottom = Math.max(ann.y, ann.y + ann.height);
		minX = Math.min(minX, left);
		maxX = Math.max(maxX, right);
		minY = Math.min(minY, top);
		maxY = Math.max(maxY, bottom);
	}

	const exportWidth = Math.max(1, Math.round(maxX - minX));
	const exportHeight = Math.max(1, Math.round(maxY - minY));
	const outputCanvas = document.createElement("canvas");
	outputCanvas.width = exportWidth;
	outputCanvas.height = exportHeight;
	const outputCtx = outputCanvas.getContext("2d");
	if (!outputCtx) throw new Error("Could not get output canvas context");
	if (!hasNoVisibleBackground(project.background.source)) {
		outputCtx.fillStyle = "white";
		outputCtx.fillRect(0, 0, exportWidth, exportHeight);
	}
	outputCtx.drawImage(canvas, -minX, -minY);

	return outputCanvas;
}

export const canvasToBlob = (
	canvas: HTMLCanvasElement,
	type: string,
	quality?: number,
) =>
	new Promise<Blob>((resolve, reject) =>
		canvas.toBlob(
			(blob) => {
				if (blob) resolve(blob);
				else reject(new Error("Failed to create blob"));
			},
			type,
			quality,
		),
	);

export const canvasNeedsTransparency = (
	canvas: HTMLCanvasElement,
	project: ProjectConfiguration,
) => {
	if (!hasNoVisibleBackground(project.background.source)) return false;

	const ctx = canvas.getContext("2d");
	if (!ctx) return true;

	const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
	for (let i = 3; i < data.length; i += 4) {
		if (data[i] !== 255) return true;
	}

	return false;
};

const stableValue = (value: unknown): unknown => {
	if (Array.isArray(value)) {
		return value.map(stableValue);
	}

	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return Object.keys(record)
			.sort()
			.reduce<Record<string, unknown>>((acc, key) => {
				const child = record[key];
				if (child !== undefined) {
					acc[key] = stableValue(child);
				}
				return acc;
			}, {});
	}

	return value;
};

const stableStringify = (value: unknown) => JSON.stringify(stableValue(value));

const fallbackHash = (input: string) => {
	let h1 = 0xdeadbeef ^ input.length;
	let h2 = 0x41c6ce57 ^ input.length;

	for (let i = 0; i < input.length; i++) {
		const char = input.charCodeAt(i);
		h1 = Math.imul(h1 ^ char, 2654435761);
		h2 = Math.imul(h2 ^ char, 1597334677);
	}

	h1 =
		Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
		Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 =
		Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
		Math.imul(h1 ^ (h1 >>> 13), 3266489909);

	return `${(h2 >>> 0).toString(36)}${(h1 >>> 0).toString(36)}`;
};

const bytesToHex = (bytes: Uint8Array) =>
	Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export const screenshotProjectFingerprint = async (
	config: ProjectConfiguration,
) => {
	const payload = stableStringify(config);
	const bytes = new TextEncoder().encode(payload);

	if (globalThis.crypto?.subtle) {
		const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
		return `sha256:${bytesToHex(new Uint8Array(digest))}`;
	}

	return `js:${fallbackHash(payload)}`;
};

const shareLinkFromUploadResult = (result: UploadResult) => {
	if (result === "NotAuthenticated") {
		throw new Error("You need to sign in to create shareable links");
	}
	if (result === "PlanCheckFailed") {
		throw new Error("Failed to verify your subscription status");
	}
	if (result === "UpgradeRequired") {
		throw new Error("This feature requires an upgraded plan");
	}

	return result.Success;
};

export const copyCurrentScreenshotShareLink = async (
	projectPath: string,
	contentHash: string,
) => {
	const result = await commands.copyCurrentScreenshotShareLink(
		projectPath,
		contentHash,
	);

	return result ? shareLinkFromUploadResult(result) : null;
};

export const uploadScreenshotShareBlob = async (
	blob: Blob,
	projectPath: string,
	contentHash?: string,
) => {
	const buffer = await blob.arrayBuffer();
	const result = await commands.uploadRenderedScreenshot(
		Array.from(new Uint8Array(buffer)),
		blob.type,
		projectPath,
		contentHash ?? null,
	);

	return shareLinkFromUploadResult(result);
};

export async function createScreenshotShareLinkFromProjectPath(
	path: string,
	onStatus?: (status: ScreenshotExportStatus) => void,
) {
	onStatus?.("encoding");
	const shareState = await commands.getScreenshotProjectShareState(path);
	const contentHash = await screenshotProjectFingerprint(shareState.config);
	if (shareState.sharing?.contentHash === contentHash) {
		const copiedLink = await copyCurrentScreenshotShareLink(path, contentHash);
		if (copiedLink) return copiedLink;
	}

	onStatus?.("rendering");
	const projectExport = await commands.renderScreenshotProjectForExport(path);
	const renderedBlob = new Blob([new Uint8Array(projectExport.imageBytes)], {
		type: "image/png",
	});
	const renderedBitmap = await createImageBitmap(renderedBlob);

	try {
		const outputCanvas = renderScreenshotExportCanvas({
			renderedBitmap,
			project: projectExport.config,
			annotations: projectExport.config.annotations ?? [],
			frame: {
				width: projectExport.imageWidth,
				height: projectExport.imageHeight,
			},
		});

		onStatus?.("encoding");
		const blob = await canvasToBlob(
			outputCanvas,
			canvasNeedsTransparency(outputCanvas, projectExport.config)
				? "image/png"
				: "image/jpeg",
			0.9,
		);

		onStatus?.("uploading");
		return await uploadScreenshotShareBlob(blob, path, contentHash);
	} finally {
		renderedBitmap.close();
	}
}
