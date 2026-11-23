import { describe, expect, test } from "vitest";
import {
	chromeInsets,
	type EvenResize,
	evenPaddingForWidth,
	evenResize,
	evenResizeFromCard,
	evenSizeAt,
	proportionalResize,
	resizedDisplay,
} from "./display-resize";

const even = (
	output: { width: number; height: number },
	aspect: number,
	fixedAspect: boolean,
	fixedCanvas: boolean,
): EvenResize => ({
	kind: "even",
	output,
	contentAspect: aspect,
	fixedAspect,
	fixedCanvas,
	cardInBox: { w: 1, h: 1 },
});

const NO_INSETS = chromeInsets("none");

describe("even padding resize", () => {
	const canvas = { width: 2136, height: 1296 };
	const display = {
		x: 108 / 2136,
		y: 108 / 1296,
		w: 1920 / 2136,
		h: 1080 / 1296,
	};

	test("a corner drag that has not moved keeps the padding", () => {
		const resize = evenResize(display, canvas, false, false, NO_INSETS);
		const { padding, rect } = resizedDisplay(display, 1, resize);
		expect(padding).toBeCloseTo(10, 6);
		expect(rect.w).toBeCloseTo(display.w, 6);
		expect(rect.h).toBeCloseTo(display.h, 6);
	});

	test("dragging outward grows the screen and inward shrinks it", () => {
		const resize = evenResize(display, canvas, false, false, NO_INSETS);
		const outward = resizedDisplay(display, 1.05, resize);
		const inward = resizedDisplay(display, 0.95, resize);
		expect(outward.padding).toBeLessThan(10);
		expect(outward.rect.w).toBeGreaterThan(display.w);
		expect(inward.padding).toBeGreaterThan(10);
		expect(inward.rect.w).toBeLessThan(display.w);
	});

	test("the proportional law misreads an evenly padded screen", () => {
		const resize = proportionalResize(display, canvas, false);
		expect(resizedDisplay(display, 1, resize).padding).toBeGreaterThan(14);
	});

	test("reads a framed card as its recording", () => {
		const insets = chromeInsets("browser");
		const contentH = Math.min(
			1920 / (16 / 9 + insets.left + insets.right),
			1080 / (1 + insets.top + insets.bottom),
		);
		const card = {
			w: contentH * (16 / 9 + insets.left + insets.right),
			h: contentH * (1 + insets.top + insets.bottom),
		};
		const resize = evenResizeFromCard(canvas, card, false, false, insets);
		expect(resize.contentAspect).toBeCloseTo(16 / 9, 9);
		const boxWidth = card.w / 2136 / resize.cardInBox.w;
		expect(evenPaddingForWidth(resize, boxWidth)).toBeCloseTo(10, 6);
	});

	test("inverts its own layout", () => {
		for (const [output, aspect] of [
			[{ width: 2136, height: 1296 }, 16 / 9],
			[{ width: 1296, height: 2136 }, 9 / 16],
			[{ width: 1920, height: 1080 }, 1.6],
		] as const) {
			for (const [fixedAspect, fixedCanvas] of [
				[false, false],
				[true, false],
				[false, true],
			] as const) {
				const resize = even(output, aspect, fixedAspect, fixedCanvas);
				for (const padding of [0, 2.5, 10, 25, 40]) {
					const { w } = evenSizeAt(resize, padding);
					expect(evenPaddingForWidth(resize, w)).toBeCloseTo(padding, 6);
				}
			}
		}
	});

	test("a style segment keeps the base canvas", () => {
		const resize = even({ width: 1920, height: 1080 }, 16 / 9, false, true);
		const { w, h } = evenSizeAt(resize, 10);
		expect(w).toBeCloseTo(1600 / 1920, 9);
		expect(h).toBeCloseTo(900 / 1080, 9);
		expect(evenPaddingForWidth(resize, 1600 / 1920)).toBeCloseTo(10, 9);
		const growing = even({ width: 1920, height: 1080 }, 16 / 9, false, false);
		expect(evenPaddingForWidth(growing, 1600 / 1920)).toBeGreaterThan(15);
	});
});

describe("proportional padding resize", () => {
	test("keeps the padding at rest and grows outward", () => {
		const scale = 1 + 2 * 0.004 * 10;
		const display = {
			x: (1 - 1 / scale) / 2,
			y: (1 - 1 / scale) / 2,
			w: 1 / scale,
			h: 1 / scale,
		};
		const resize = proportionalResize(
			display,
			{ width: 1920 * scale, height: 1080 * scale },
			false,
		);
		expect(resizedDisplay(display, 1, resize).padding).toBeCloseTo(10, 6);
		expect(resizedDisplay(display, 1.05, resize).padding).toBeLessThan(10);
		expect(resizedDisplay(display, 0.95, resize).padding).toBeGreaterThan(10);
	});
});
