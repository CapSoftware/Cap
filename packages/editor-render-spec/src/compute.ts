import { clamp, isFiniteNumber, toEven } from "./math";
import type {
	NormalizedRenderConfig,
	RenderCameraSpec,
	RenderInnerRect,
	RenderSpec,
} from "./types";
import { ASPECT_RATIO_VALUES } from "./types";

export function scaleRenderSpec(
	spec: RenderSpec,
	targetWidth: number,
): RenderSpec {
	const scale = targetWidth / spec.outputWidth;

	const scaleRect = (rect: RenderInnerRect): RenderInnerRect => ({
		x: Math.round(rect.x * scale),
		y: Math.round(rect.y * scale),
		width: Math.round(rect.width * scale),
		height: Math.round(rect.height * scale),
	});

	return {
		outputWidth: Math.round(spec.outputWidth * scale),
		outputHeight: Math.round(spec.outputHeight * scale),
		innerRect: scaleRect(spec.innerRect),
		videoCrop: spec.videoCrop,
		backgroundSpec: spec.backgroundSpec,
		maskSpec: {
			...spec.maskSpec,
			radiusPx: Math.round(spec.maskSpec.radiusPx * scale),
		},
		shadowSpec: {
			...spec.shadowSpec,
			offsetX: spec.shadowSpec.offsetX * scale,
			offsetY: spec.shadowSpec.offsetY * scale,
			blurPx: spec.shadowSpec.blurPx * scale,
			spreadPx: spec.shadowSpec.spreadPx * scale,
		},
		cameraSpec: spec.cameraSpec
			? {
					...spec.cameraSpec,
					rect: scaleRect(spec.cameraSpec.rect),
					rounding: Math.round(spec.cameraSpec.rounding * scale),
					shadow: {
						...spec.cameraSpec.shadow,
						offsetX: spec.cameraSpec.shadow.offsetX * scale,
						offsetY: spec.cameraSpec.shadow.offsetY * scale,
						blurPx: spec.cameraSpec.shadow.blurPx * scale,
						spreadPx: spec.cameraSpec.shadow.spreadPx * scale,
					},
				}
			: undefined,
	};
}

function normalizeVideoCrop(
	crop: NormalizedRenderConfig["background"]["crop"],
	sourceWidth: number,
	sourceHeight: number,
): RenderInnerRect {
	if (!crop) {
		return { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
	}

	const maxX = Math.max(0, sourceWidth - 2);
	const maxY = Math.max(0, sourceHeight - 2);
	const x = clamp(Math.round(crop.x), 0, maxX);
	const y = clamp(Math.round(crop.y), 0, maxY);
	const width = clamp(Math.round(crop.width), 2, sourceWidth - x);
	const height = clamp(Math.round(crop.height), 2, sourceHeight - y);

	return { x, y, width, height };
}

function fitContainedInnerRect(
	containerWidth: number,
	containerHeight: number,
	contentRatio: number,
): Pick<RenderInnerRect, "width" | "height"> {
	let width = containerWidth;
	let height = containerHeight;

	if (containerWidth / containerHeight > contentRatio) {
		height = containerHeight;
		width = toEven(height * contentRatio);
		if (width > containerWidth) {
			width = containerWidth;
			height = toEven(width / contentRatio);
		}
	} else {
		width = containerWidth;
		height = toEven(width / contentRatio);
		if (height > containerHeight) {
			height = containerHeight;
			width = toEven(height * contentRatio);
		}
	}

	return {
		width: clamp(width, 2, containerWidth),
		height: clamp(height, 2, containerHeight),
	};
}

export function computeRenderSpec(
	config: NormalizedRenderConfig,
	sourceWidth: number,
	sourceHeight: number,
): RenderSpec {
	const safeSourceWidth = toEven(
		isFiniteNumber(sourceWidth) && sourceWidth > 0 ? sourceWidth : 16,
	);
	const safeSourceHeight = toEven(
		isFiniteNumber(sourceHeight) && sourceHeight > 0 ? sourceHeight : 9,
	);

	const videoCrop = normalizeVideoCrop(
		config.background.crop,
		safeSourceWidth,
		safeSourceHeight,
	);
	const baseWidth = toEven(videoCrop.width);
	const baseHeight = toEven(videoCrop.height);
	const sourceRatio = baseWidth / baseHeight;
	const targetRatio = config.aspectRatio
		? (() => {
				const [w, h] = ASPECT_RATIO_VALUES[config.aspectRatio];
				return w / h;
			})()
		: sourceRatio;

	let outputWidth = baseWidth;
	let outputHeight = baseHeight;

	if (Math.abs(targetRatio - sourceRatio) > 0.0001) {
		if (targetRatio > sourceRatio) {
			outputWidth = toEven(baseHeight * targetRatio);
		} else {
			outputHeight = toEven(baseWidth / targetRatio);
		}
	}

	const shadowAmount = clamp(config.background.shadow, 0, 100);
	const shadowEnabled = shadowAmount > 0;
	const shadowSize = clamp(config.background.advancedShadow.size, 0, 100);
	const shadowBlur = clamp(config.background.advancedShadow.blur, 0, 100);
	const shadowOpacity = clamp(config.background.advancedShadow.opacity, 0, 100);

	const offsetY = shadowEnabled
		? Number((2 + shadowSize * 0.14).toFixed(2))
		: 0;
	const blurPx = shadowEnabled
		? Number((4 + shadowBlur * 0.78 + shadowAmount * 0.22).toFixed(2))
		: 0;
	const spreadPx = shadowEnabled ? Number((shadowSize * 0.12).toFixed(2)) : 0;
	const alpha = shadowEnabled
		? Number(
				Math.max(
					0,
					Math.min(0.95, (shadowOpacity / 100) * (shadowAmount / 100) * 0.9),
				).toFixed(4),
			)
		: 0;

	const paddingPercent = clamp(config.background.padding, 0, 40);
	const innerScale = Math.max(0.05, 1 - (paddingPercent / 100) * 2);
	const paddedInnerWidth = toEven(outputWidth * innerScale);
	const paddedInnerHeight = toEven(outputHeight * innerScale);
	const contentRatio = videoCrop.width / videoCrop.height;
	const initialInnerSize = fitContainedInnerRect(
		paddedInnerWidth,
		paddedInnerHeight,
		contentRatio,
	);
	let fitContainerWidth = paddedInnerWidth;
	let fitContainerHeight = paddedInnerHeight;

	if (shadowEnabled) {
		const insetX = Math.ceil(spreadPx + blurPx * 0.6);
		const insetY = Math.ceil(spreadPx + blurPx * 0.6 + Math.max(0, offsetY));

		if (initialInnerSize.width >= paddedInnerWidth - 1) {
			fitContainerWidth = Math.max(2, paddedInnerWidth - insetX * 2);
		}

		if (initialInnerSize.height >= paddedInnerHeight - 1) {
			fitContainerHeight = Math.max(2, paddedInnerHeight - insetY * 2);
		}
	}

	const innerSize = fitContainedInnerRect(
		fitContainerWidth,
		fitContainerHeight,
		contentRatio,
	);
	const innerWidth = innerSize.width;
	const innerHeight = innerSize.height;
	const innerX = Math.round((outputWidth - innerWidth) / 2);
	const innerY = Math.round((outputHeight - innerHeight) / 2);

	const rounding = clamp(config.background.rounding, 0, 100);
	const roundingMultiplier =
		config.background.roundingType === "rounded" ? 1 : 0.8;
	const radiusPx = Math.round(
		(Math.min(innerWidth, innerHeight) / 2) *
			(rounding / 100) *
			roundingMultiplier,
	);

	let cameraSpec: RenderCameraSpec | undefined;
	if (config.camera && !config.camera.hide) {
		cameraSpec = computeCameraSpec(config.camera, outputWidth, outputHeight);
	}

	return {
		outputWidth,
		outputHeight,
		innerRect: {
			x: innerX,
			y: innerY,
			width: innerWidth,
			height: innerHeight,
		},
		videoCrop,
		backgroundSpec: config.background.source,
		maskSpec: {
			shape: "roundedRect",
			roundingType: config.background.roundingType,
			radiusPx,
		},
		shadowSpec: {
			enabled: shadowEnabled,
			offsetX: 0,
			offsetY: offsetY,
			blurPx,
			spreadPx,
			alpha,
		},
		cameraSpec,
	};
}

function computeCameraSpec(
	cam: NonNullable<NormalizedRenderConfig["camera"]>,
	outputWidth: number,
	outputHeight: number,
): RenderCameraSpec {
	const sizePercent = cam.size / 100;
	const camSize = Math.round(Math.min(outputWidth, outputHeight) * sizePercent);
	const margin = Math.round(outputWidth * 0.03);

	let camX: number;
	if (cam.position.x === "left") {
		camX = margin;
	} else if (cam.position.x === "center") {
		camX = Math.round((outputWidth - camSize) / 2);
	} else {
		camX = outputWidth - camSize - margin;
	}

	let camY: number;
	if (cam.position.y === "top") {
		camY = margin;
	} else {
		camY = outputHeight - camSize - margin;
	}

	const roundingMultiplier = cam.roundingType === "rounded" ? 1 : 0.8;
	const camRadius = Math.round(
		(camSize / 2) * (cam.rounding / 100) * roundingMultiplier,
	);

	const camShadowAmount = clamp(cam.shadow, 0, 100);
	const camShadowEnabled = camShadowAmount > 0;
	const camShadowSize = clamp(cam.advancedShadow.size, 0, 100);
	const camShadowBlur = clamp(cam.advancedShadow.blur, 0, 100);
	const camShadowOpacity = clamp(cam.advancedShadow.opacity, 0, 100);

	const camOffsetY = camShadowEnabled
		? Number((2 + camShadowSize * 0.14).toFixed(2))
		: 0;
	const camBlurPx = camShadowEnabled
		? Number((4 + camShadowBlur * 0.78 + camShadowAmount * 0.22).toFixed(2))
		: 0;
	const camSpreadPx = camShadowEnabled
		? Number((camShadowSize * 0.12).toFixed(2))
		: 0;
	const camAlpha = camShadowEnabled
		? Number(
				Math.max(
					0,
					Math.min(
						0.95,
						(camShadowOpacity / 100) * (camShadowAmount / 100) * 0.9,
					),
				).toFixed(4),
			)
		: 0;

	return {
		position: cam.position,
		rect: { x: camX, y: camY, width: camSize, height: camSize },
		rounding: camRadius,
		roundingType: cam.roundingType,
		shadow: {
			enabled: camShadowEnabled,
			offsetX: 0,
			offsetY: camOffsetY,
			blurPx: camBlurPx,
			spreadPx: camSpreadPx,
			alpha: camAlpha,
		},
		mirror: cam.mirror,
	};
}
