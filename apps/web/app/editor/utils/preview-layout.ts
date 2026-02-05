import type { CSSProperties } from "react";
import type {
	AspectRatio,
	BackgroundConfiguration,
	BackgroundSource,
	ProjectConfiguration,
} from "../types/project-config";
import { resolveBackgroundSourcePath } from "./backgrounds";

const ASPECT_RATIO_VALUES: Record<AspectRatio, [number, number]> = {
	wide: [16, 9],
	vertical: [9, 16],
	square: [1, 1],
	classic: [4, 3],
	tall: [3, 4],
};

function clamp(value: number, min: number, max: number): number {
	if (value < min) return min;
	if (value > max) return max;
	return value;
}

function normalizeChannel(value: number): number {
	return Math.round(clamp(value, 0, 255));
}

function getAspectRatio(
	project: ProjectConfiguration,
	width: number,
	height: number,
) {
	if (project.aspectRatio) {
		const [w, h] = ASPECT_RATIO_VALUES[project.aspectRatio];
		return w / h;
	}

	const safeWidth = width > 0 ? width : 16;
	const safeHeight = height > 0 ? height : 9;
	return safeWidth / safeHeight;
}

function getBackgroundStyle(source: BackgroundSource): CSSProperties {
	if (source.type === "color") {
		const [r, g, b] = source.value;
		const alpha = clamp(source.alpha ?? 1, 0, 1);
		return {
			backgroundColor: `rgba(${normalizeChannel(r)}, ${normalizeChannel(g)}, ${normalizeChannel(b)}, ${alpha})`,
		};
	}

	if (source.type === "gradient") {
		const angle = clamp(source.angle ?? 90, 0, 360);
		const [fromR, fromG, fromB] = source.from;
		const [toR, toG, toB] = source.to;
		return {
			backgroundImage: `linear-gradient(${angle}deg, rgb(${normalizeChannel(fromR)}, ${normalizeChannel(fromG)}, ${normalizeChannel(fromB)}), rgb(${normalizeChannel(toR)}, ${normalizeChannel(toG)}, ${normalizeChannel(toB)}))`,
		};
	}

	const path = resolveBackgroundSourcePath(source);
	if (!path) {
		return { backgroundColor: "rgb(255, 255, 255)" };
	}

	return {
		backgroundImage: `url("${path}")`,
		backgroundPosition: "center",
		backgroundSize: "cover",
		backgroundRepeat: "no-repeat",
	};
}

function getBorderRadius(background: BackgroundConfiguration): string {
	const rounding = clamp(background.rounding, 0, 100);
	const base = rounding / 2;
	const multiplier = background.roundingType === "rounded" ? 1 : 0.8;
	return `${base * multiplier}%`;
}

function getBoxShadow(background: BackgroundConfiguration): string {
	const shadow = clamp(background.shadow, 0, 100);
	if (shadow <= 0) return "none";

	const shadowSize = clamp(background.advancedShadow?.size ?? 50, 0, 100);
	const shadowBlur = clamp(background.advancedShadow?.blur ?? 50, 0, 100);
	const shadowOpacity = clamp(background.advancedShadow?.opacity ?? 18, 0, 100);

	const offsetY = Number((2 + shadowSize * 0.14).toFixed(2));
	const blur = Number((4 + shadowBlur * 0.78 + shadow * 0.22).toFixed(2));
	const spread = Number((shadowSize * 0.12).toFixed(2));
	const alpha = Number(
		Math.max(
			0,
			Math.min(0.95, (shadowOpacity / 100) * (shadow / 100) * 0.9),
		).toFixed(4),
	);

	return `0 ${offsetY}px ${blur}px ${spread}px rgba(0, 0, 0, ${alpha})`;
}

export function getPreviewLayoutStyles(
	project: ProjectConfiguration,
	video: { width: number; height: number },
): {
	frameClassName: string;
	frameStyle: CSSProperties;
	contentStyle: CSSProperties;
	videoStyle: CSSProperties;
} {
	const aspectRatio = getAspectRatio(project, video.width, video.height);
	const paddingPercent = clamp(project.background.padding, 0, 40);
	const insetScale = Math.max(0.05, 1 - (paddingPercent / 100) * 2);

	return {
		frameClassName:
			aspectRatio >= 1
				? "w-full h-auto max-h-full"
				: "h-full w-auto max-w-full",
		frameStyle: {
			aspectRatio: `${aspectRatio}`,
			...getBackgroundStyle(project.background.source),
		},
		contentStyle: {
			width: `${insetScale * 100}%`,
			height: `${insetScale * 100}%`,
			borderRadius: getBorderRadius(project.background),
			boxShadow: getBoxShadow(project.background),
			overflow: "hidden",
		},
		videoStyle: {
			width: "100%",
			height: "100%",
		},
	};
}
