import { commands } from "../../../engine/editor-api";
import { pickFile } from "../../../engine/file-picker";
import type { ImageSegment, XY } from "../../../engine/types";

export type { ImageSegment } from "../../../engine/types";
export type ImageAsset = {
	path: string;
	name: string;
	width: number;
	height: number;
};

export function fitImageSize(
	width: number,
	height: number,
	outputWidth: number,
	outputHeight: number,
): XY<number> {
	if (
		![width, height, outputWidth, outputHeight].every(
			(value) => Number.isFinite(value) && value > 0,
		)
	)
		return { x: 0.3, y: 0.3 };
	const scale = Math.min(
		(outputWidth * 0.3) / width,
		(outputHeight * 0.3) / height,
	);
	return {
		x: (width * scale) / outputWidth,
		y: (height * scale) / outputHeight,
	};
}

export function defaultImageSegment(
	asset: ImageAsset,
	start: number,
	end: number,
	track: number,
	output: { width: number; height: number },
): ImageSegment {
	return {
		start,
		end,
		track,
		enabled: true,
		path: asset.path,
		name: asset.name,
		center: { x: 0.5, y: 0.5 },
		size: fitImageSize(asset.width, asset.height, output.width, output.height),
		opacity: 1,
		rotation: 0,
		rounding: 0,
		flipX: false,
		flipY: false,
		lockAspect: true,
	};
}

export function imageAssetPath(projectPath: string, relative: string) {
	if (!/^content\/images\/[^/\\]+$/.test(relative) || relative.includes(".."))
		return null;
	return `${projectPath.replace(/[\\/]$/, "")}/${relative}`;
}

export function resizeImage(
	segment: Pick<ImageSegment, "center" | "size" | "rotation" | "lockAspect">,
	delta: XY<number>,
	corner: XY<number>,
	canvas: { width: number; height: number },
) {
	const radians = (segment.rotation * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	const localX = delta.x * cos + delta.y * sin;
	const localY = -delta.x * sin + delta.y * cos;
	const width = segment.size.x * canvas.width;
	const height = segment.size.y * canvas.height;
	let nextWidth = Math.max(8, width + corner.x * localX);
	let nextHeight = Math.max(8, height + corner.y * localY);
	if (segment.lockAspect) {
		const scale = Math.max(
			8 / Math.max(1, Math.min(width, height)),
			(nextWidth * width + nextHeight * height) /
				Math.max(1, width * width + height * height),
		);
		nextWidth = width * scale;
		nextHeight = height * scale;
	}
	const offsetX = (corner.x * (nextWidth - width)) / 2;
	const offsetY = (corner.y * (nextHeight - height)) / 2;
	return {
		center: {
			x: segment.center.x + (offsetX * cos - offsetY * sin) / canvas.width,
			y: segment.center.y + (offsetX * sin + offsetY * cos) / canvas.height,
		},
		size: { x: nextWidth / canvas.width, y: nextHeight / canvas.height },
	};
}

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];

export async function pickImage(): Promise<ImageAsset | null> {
	const file = await pickFile(IMAGE_EXTENSIONS);
	if (!file) return null;
	return commands.importEditorImage(file) as Promise<ImageAsset>;
}
