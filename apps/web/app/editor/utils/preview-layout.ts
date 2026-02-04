import type { CSSProperties } from "react";
import type {
	AspectRatio,
	BackgroundSource,
	ProjectConfiguration,
} from "../types/project-config";

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

function getBackgroundStyle(source: BackgroundSource): string {
	if (source.type === "color") {
		const [r, g, b] = source.value;
		const alpha = clamp(source.alpha ?? 1, 0, 1);
		return `rgba(${normalizeChannel(r)}, ${normalizeChannel(g)}, ${normalizeChannel(b)}, ${alpha})`;
	}

	if (source.type === "gradient") {
		const [r, g, b] = source.from;
		return `rgb(${normalizeChannel(r)}, ${normalizeChannel(g)}, ${normalizeChannel(b)})`;
	}

	return "rgb(255, 255, 255)";
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
	const paddingPercent = clamp(project.background.padding, 0, 45);
	const insetScale = Math.max(0.05, 1 - (paddingPercent / 100) * 2);

	return {
		frameClassName:
			aspectRatio >= 1
				? "w-full h-auto max-h-full"
				: "h-full w-auto max-w-full",
		frameStyle: {
			aspectRatio: `${aspectRatio}`,
			background: getBackgroundStyle(project.background.source),
			borderRadius: "14px",
		},
		contentStyle: {
			width: `${insetScale * 100}%`,
			height: `${insetScale * 100}%`,
		},
		videoStyle: {},
	};
}
