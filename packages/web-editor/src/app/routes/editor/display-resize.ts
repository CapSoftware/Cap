import type { FrameStyle } from "../../../engine/types";
import type { NormRect } from "./snapping";

export type ChromeInsets = {
	top: number;
	right: number;
	bottom: number;
	left: number;
};

const MACBOOK_BEZEL = 0.028;
const MACBOOK_DECK = 0.045;
const MACBOOK_OVERHANG = 0.1;
const MACBOOK_SHADOW_ROOM = 0.035;

export function chromeInsets(
	style: FrameStyle | null | undefined,
): ChromeInsets {
	switch (style) {
		case "macOS":
			return { top: 0.055, right: 0, bottom: 0, left: 0 };
		case "windows":
			return { top: 0.05, right: 0, bottom: 0, left: 0 };
		case "browser":
			return { top: 0.075, right: 0, bottom: 0, left: 0 };
		case "macbook":
			return {
				top: MACBOOK_BEZEL,
				right: MACBOOK_BEZEL + MACBOOK_OVERHANG,
				bottom: MACBOOK_BEZEL + MACBOOK_DECK + MACBOOK_SHADOW_ROOM,
				left: MACBOOK_BEZEL + MACBOOK_OVERHANG,
			};
		default:
			return { top: 0, right: 0, bottom: 0, left: 0 };
	}
}

const clamp = (value: number, min: number, max: number) =>
	Math.min(Math.max(value, min), max);

export type ProportionalResize = {
	kind: "proportional";
	maxWidth: number;
	paddingScale: number;
};

export type EvenResize = {
	kind: "even";
	output: { width: number; height: number };
	contentAspect: number;
	fixedAspect: boolean;
	fixedCanvas: boolean;
	cardInBox: { w: number; h: number };
};

export type DisplayResize = ProportionalResize | EvenResize;

type Output = { width: number; height: number };

export function proportionalResize(
	rect: NormRect,
	output: Output,
	fixedAspect: boolean,
): ProportionalResize {
	const width = Math.max(output.width, 1);
	const height = Math.max(output.height, 1);
	const contentAspect = (rect.w * width) / Math.max(rect.h * height, 1e-6);
	const frameAspect = width / height;
	const k = !fixedAspect
		? 1
		: contentAspect <= frameAspect
			? Math.max(1, contentAspect)
			: Math.max(1, 1 / contentAspect);
	return {
		kind: "proportional",
		maxWidth: Math.min(1, contentAspect / frameAspect),
		paddingScale: (2 * k * 0.4) / 100,
	};
}

export function evenResizeFromCard(
	output: Output,
	card: { w: number; h: number },
	fixedAspect: boolean,
	fixedCanvas: boolean,
	insets: ChromeInsets,
): EvenResize {
	const contentHeight = card.h / (1 + insets.top + insets.bottom);
	const contentAspect = Math.max(
		card.w / contentHeight - insets.left - insets.right,
		1e-6,
	);
	const box =
		card.w / card.h >= contentAspect
			? { w: card.w, h: card.w / contentAspect }
			: { w: card.h * contentAspect, h: card.h };
	return {
		kind: "even",
		output,
		contentAspect,
		fixedAspect,
		fixedCanvas,
		cardInBox: { w: card.w / box.w, h: card.h / box.h },
	};
}

export function evenResize(
	rect: NormRect,
	output: Output,
	fixedAspect: boolean,
	fixedCanvas: boolean,
	insets: ChromeInsets,
): EvenResize {
	const size = {
		width: Math.max(output.width, 1),
		height: Math.max(output.height, 1),
	};
	return evenResizeFromCard(
		size,
		{
			w: Math.max(rect.w * size.width, 1e-6),
			h: Math.max(rect.h * size.height, 1e-6),
		},
		fixedAspect,
		fixedCanvas,
		insets,
	);
}

export function evenPaddingForWidth(resize: EvenResize, width: number) {
	const { width: outputW, height: outputH } = resize.output;
	const aspect = resize.contentAspect;
	let ratio: number;
	if (resize.fixedAspect) {
		const fromWidth = (outputW - width * outputW) / 2;
		const fromHeight = (outputH - (width * outputW) / aspect) / 2;
		const inset = clamp(
			Math.min(fromWidth, fromHeight) / Math.min(outputW, outputH),
			0,
			0.4999,
		);
		ratio = inset / (1 - 2 * inset);
	} else if (resize.fixedCanvas) {
		const shorter = Math.min(aspect, 1);
		const height = Math.max((width * outputW) / aspect, 1e-6);
		const fromWidth = (outputW / height - aspect) / (2 * shorter);
		const fromHeight = (outputH / height - 1) / (2 * shorter);
		ratio = Math.min(fromWidth, fromHeight);
	} else {
		const shorterOverWidth = Math.min(1 / aspect, 1);
		ratio = (1 / Math.max(width, 1e-6) - 1) / (2 * shorterOverWidth);
	}
	return clamp(ratio * 100, 0, 100);
}

export function evenSizeAt(resize: EvenResize, padding: number) {
	const ratio = padding / 100;
	const aspect = resize.contentAspect;
	const { width: outputW, height: outputH } = resize.output;
	if (resize.fixedAspect) {
		const inset = (Math.min(outputW, outputH) * ratio) / (1 + 2 * ratio);
		const available = {
			w: Math.max(outputW - 2 * inset, 1),
			h: Math.max(outputH - 2 * inset, 1),
		};
		const size =
			aspect <= available.w / available.h
				? { w: available.h * aspect, h: available.h }
				: { w: available.w, h: available.w / aspect };
		return { w: size.w / outputW, h: size.h / outputH };
	}
	if (resize.fixedCanvas) {
		const margin = 2 * ratio * Math.min(aspect, 1);
		const height = Math.min(
			outputW / (aspect + margin),
			outputH / (1 + margin),
		);
		return { w: (aspect * height) / outputW, h: height / outputH };
	}
	return {
		w: 1 / (1 + 2 * ratio * Math.min(1 / aspect, 1)),
		h: 1 / (1 + 2 * ratio * Math.min(aspect, 1)),
	};
}

export function resizedDisplay(
	start: NormRect,
	scale: number,
	resize: DisplayResize,
): { rect: NormRect; padding: number } {
	const anchor = { x: start.x + start.w / 2, y: start.y + start.h / 2 };
	const targetWidth = Math.max(start.w * scale, 1e-6);
	let padding: number;
	let w: number;
	let h: number;
	if (resize.kind === "even") {
		padding = evenPaddingForWidth(resize, targetWidth / resize.cardInBox.w);
		const size = evenSizeAt(resize, padding);
		w = size.w * resize.cardInBox.w;
		h = size.h * resize.cardInBox.h;
	} else {
		padding = clamp(
			(resize.maxWidth / targetWidth - 1) / Math.max(resize.paddingScale, 1e-9),
			0,
			100,
		);
		const applied =
			resize.maxWidth / (1 + resize.paddingScale * padding) / start.w;
		w = start.w * applied;
		h = start.h * applied;
	}
	return {
		rect: {
			x: clamp(anchor.x - w / 2, 0, Math.max(0, 1 - w)),
			y: clamp(anchor.y - h / 2, 0, Math.max(0, 1 - h)),
			w,
			h,
		},
		padding,
	};
}
