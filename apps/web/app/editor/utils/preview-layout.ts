import {
	type BackgroundSourceSpec,
	computeRenderSpec,
	normalizeConfigForRender,
	type RenderSpec,
} from "@cap/editor-render-spec";
import type { CSSProperties } from "react";
import type { ProjectConfiguration } from "../types/project-config";
import { resolveBackgroundAssetPath } from "./backgrounds";

function getBackgroundStyle(source: BackgroundSourceSpec): CSSProperties {
	if (source.type === "color") {
		const [r, g, b] = source.value;
		return {
			backgroundColor: `rgba(${r}, ${g}, ${b}, ${source.alpha})`,
		};
	}

	if (source.type === "gradient") {
		const [fromR, fromG, fromB] = source.from;
		const [toR, toG, toB] = source.to;
		return {
			backgroundImage: `linear-gradient(${source.angle}deg, rgb(${fromR}, ${fromG}, ${fromB}), rgb(${toR}, ${toG}, ${toB}))`,
		};
	}

	if (!source.path) {
		return { backgroundColor: "rgb(255, 255, 255)" };
	}

	const path = resolveBackgroundAssetPath(source.path);
	return {
		backgroundImage: `url("${path}")`,
		backgroundPosition: "center",
		backgroundSize: "cover",
		backgroundRepeat: "no-repeat",
	};
}

function getBorderRadius(spec: RenderSpec): string {
	const radiusPx = spec.maskSpec.radiusPx;
	if (radiusPx <= 0) return "0px";
	const rx = (radiusPx / spec.innerRect.width) * 100;
	const ry = (radiusPx / spec.innerRect.height) * 100;
	return `${Number(rx.toFixed(4))}% / ${Number(ry.toFixed(4))}%`;
}

function getBoxShadow(spec: RenderSpec): string {
	const shadow = spec.shadowSpec;
	if (!shadow.enabled || shadow.alpha <= 0) return "none";
	return `0 ${shadow.offsetY}px ${shadow.blurPx}px ${shadow.spreadPx}px rgba(0, 0, 0, ${shadow.alpha})`;
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
	const normalized = normalizeConfigForRender(project);
	const spec = computeRenderSpec(normalized.config, video.width, video.height);
	const aspectRatio = spec.outputWidth / spec.outputHeight;
	const widthScale = (spec.innerRect.width / spec.outputWidth) * 100;
	const heightScale = (spec.innerRect.height / spec.outputHeight) * 100;

	return {
		frameClassName:
			aspectRatio >= 1
				? "w-full h-auto max-h-full"
				: "h-full w-auto max-w-full",
		frameStyle: {
			aspectRatio: `${aspectRatio}`,
			...getBackgroundStyle(spec.backgroundSpec),
		},
		contentStyle: {
			width: `${Number(widthScale.toFixed(4))}%`,
			height: `${Number(heightScale.toFixed(4))}%`,
			borderRadius: getBorderRadius(spec),
			boxShadow: getBoxShadow(spec),
			overflow: "hidden",
		},
		videoStyle: {
			width: "100%",
			height: "100%",
		},
	};
}
