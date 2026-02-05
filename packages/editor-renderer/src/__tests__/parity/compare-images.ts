import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createCanvas, loadImage } from "@napi-rs/canvas";

export interface ComparisonResult {
	match: boolean;
	hashMatch: boolean;
	diffPixelCount: number;
	totalPixels: number;
	diffPercent: number;
	maxChannelDiff: number;
	avgChannelDiff: number;
	threshold: number;
}

export function computeImageHash(png: Buffer): string {
	return createHash("sha256").update(png).digest("hex");
}

export async function compareImages(
	actualPng: Buffer,
	goldenPath: string,
	threshold = 0.01,
): Promise<ComparisonResult> {
	if (!existsSync(goldenPath)) {
		return {
			match: false,
			hashMatch: false,
			diffPixelCount: -1,
			totalPixels: -1,
			diffPercent: 100,
			maxChannelDiff: 255,
			avgChannelDiff: 255,
			threshold,
		};
	}

	const goldenPng = readFileSync(goldenPath);

	const actualHash = computeImageHash(actualPng);
	const goldenHash = computeImageHash(goldenPng);
	const hashMatch = actualHash === goldenHash;

	if (hashMatch) {
		const img = await loadImage(actualPng);
		const totalPixels = img.width * img.height;
		return {
			match: true,
			hashMatch: true,
			diffPixelCount: 0,
			totalPixels,
			diffPercent: 0,
			maxChannelDiff: 0,
			avgChannelDiff: 0,
			threshold,
		};
	}

	const actualImg = await loadImage(actualPng);
	const goldenImg = await loadImage(goldenPng);

	if (
		actualImg.width !== goldenImg.width ||
		actualImg.height !== goldenImg.height
	) {
		const totalPixels = Math.max(
			actualImg.width * actualImg.height,
			goldenImg.width * goldenImg.height,
		);
		return {
			match: false,
			hashMatch: false,
			diffPixelCount: totalPixels,
			totalPixels,
			diffPercent: 100,
			maxChannelDiff: 255,
			avgChannelDiff: 255,
			threshold,
		};
	}

	const width = actualImg.width;
	const height = actualImg.height;
	const totalPixels = width * height;

	const actualCanvas = createCanvas(width, height);
	const actualCtx = actualCanvas.getContext("2d");
	actualCtx.drawImage(actualImg, 0, 0);
	const actualData = actualCtx.getImageData(0, 0, width, height).data;

	const goldenCanvas = createCanvas(width, height);
	const goldenCtx = goldenCanvas.getContext("2d");
	goldenCtx.drawImage(goldenImg, 0, 0);
	const goldenData = goldenCtx.getImageData(0, 0, width, height).data;

	let diffPixelCount = 0;
	let maxChannelDiff = 0;
	let totalChannelDiff = 0;

	for (let i = 0; i < actualData.length; i += 4) {
		const rDiff = Math.abs(actualData[i] - goldenData[i]);
		const gDiff = Math.abs(actualData[i + 1] - goldenData[i + 1]);
		const bDiff = Math.abs(actualData[i + 2] - goldenData[i + 2]);
		const aDiff = Math.abs(actualData[i + 3] - goldenData[i + 3]);

		const pixelDiff = Math.max(rDiff, gDiff, bDiff, aDiff);
		maxChannelDiff = Math.max(maxChannelDiff, pixelDiff);
		totalChannelDiff += rDiff + gDiff + bDiff + aDiff;

		if (pixelDiff > 2) {
			diffPixelCount++;
		}
	}

	const diffPercent = (diffPixelCount / totalPixels) * 100;
	const avgChannelDiff = totalChannelDiff / (totalPixels * 4);
	const match = diffPercent <= threshold * 100;

	return {
		match,
		hashMatch,
		diffPixelCount,
		totalPixels,
		diffPercent,
		maxChannelDiff,
		avgChannelDiff,
		threshold,
	};
}

export function saveGolden(goldenPath: string, png: Buffer): void {
	writeFileSync(goldenPath, png);
}

export async function generateDiffImage(
	actualPng: Buffer,
	goldenPath: string,
): Promise<Buffer | null> {
	if (!existsSync(goldenPath)) {
		return null;
	}

	const goldenPng = readFileSync(goldenPath);

	const actualImg = await loadImage(actualPng);
	const goldenImg = await loadImage(goldenPng);

	if (
		actualImg.width !== goldenImg.width ||
		actualImg.height !== goldenImg.height
	) {
		return null;
	}

	const width = actualImg.width;
	const height = actualImg.height;

	const actualCanvas = createCanvas(width, height);
	const actualCtx = actualCanvas.getContext("2d");
	actualCtx.drawImage(actualImg, 0, 0);
	const actualData = actualCtx.getImageData(0, 0, width, height);

	const goldenCanvas = createCanvas(width, height);
	const goldenCtx = goldenCanvas.getContext("2d");
	goldenCtx.drawImage(goldenImg, 0, 0);
	const goldenData = goldenCtx.getImageData(0, 0, width, height);

	const diffCanvas = createCanvas(width, height);
	const diffCtx = diffCanvas.getContext("2d");
	const diffData = diffCtx.createImageData(width, height);

	for (let i = 0; i < actualData.data.length; i += 4) {
		const rDiff = Math.abs(actualData.data[i] - goldenData.data[i]);
		const gDiff = Math.abs(actualData.data[i + 1] - goldenData.data[i + 1]);
		const bDiff = Math.abs(actualData.data[i + 2] - goldenData.data[i + 2]);

		const maxDiff = Math.max(rDiff, gDiff, bDiff);

		if (maxDiff > 2) {
			diffData.data[i] = 255;
			diffData.data[i + 1] = 0;
			diffData.data[i + 2] = 0;
			diffData.data[i + 3] = Math.min(255, maxDiff * 3);
		} else {
			diffData.data[i] = actualData.data[i];
			diffData.data[i + 1] = actualData.data[i + 1];
			diffData.data[i + 2] = actualData.data[i + 2];
			diffData.data[i + 3] = 128;
		}
	}

	diffCtx.putImageData(diffData, 0, 0);

	return diffCanvas.toBuffer("image/png");
}
