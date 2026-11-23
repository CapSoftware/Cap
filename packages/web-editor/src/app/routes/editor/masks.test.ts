import { describe, expect, it } from "vitest";

import {
	defaultMaskSegment,
	encodeMaskEffect,
	getMaskEffect,
	getMaskEffectAmount,
} from "./masks";

describe("mask effects", () => {
	it("defaults new sensitive masks to a fully obscuring blur", () => {
		const segment = defaultMaskSegment(0, 1);

		expect(getMaskEffect(segment)).toBe("blur");
		expect(getMaskEffectAmount(segment)).toBe(16);
		expect(segment.opacity).toBe(1);
	});

	it("preserves legacy pixelation values", () => {
		const segment = defaultMaskSegment(0, 1);
		segment.pixelation = 18;

		expect(getMaskEffect(segment)).toBe("pixelate");
		expect(getMaskEffectAmount(segment)).toBe(18);
	});

	it("encodes blur as a privacy-safe legacy pixelation fallback", () => {
		const segment = defaultMaskSegment(0, 1);
		segment.pixelation = encodeMaskEffect("blur", 24);

		expect(segment.pixelation).toBe(1024);
		expect(getMaskEffect(segment)).toBe("blur");
		expect(getMaskEffectAmount(segment)).toBe(24);
	});

	it("keeps effect amounts within the supported range", () => {
		const segment = defaultMaskSegment(0, 1);
		segment.pixelation = encodeMaskEffect("pixelate", Number.NaN);

		expect(getMaskEffectAmount(segment)).toBe(16);
		expect(encodeMaskEffect("pixelate", 1)).toBe(4);
		expect(encodeMaskEffect("blur", 100)).toBe(1080);
	});
});
