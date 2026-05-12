import { describe, expect, it } from "vitest";

import {
	calculateStrokeDashoffset,
	classNames,
	getDisplayProgress,
	getProgressCircleConfig,
	isEmailAllowedByRestriction,
	uuidFormat,
	uuidParse,
} from "./helpers";

describe("helpers", () => {
	it("merges class names and resolves conflicting Tailwind utilities", () => {
		expect(classNames("px-2 text-sm", false, "px-4")).toBe("text-sm px-4");
	});

	it("round-trips uuid formatting helpers", () => {
		const formatted = "123e4567-e89b-12d3-a456-426614174000";
		const compact = "123e4567e89b12d3a456426614174000";

		expect(uuidParse(formatted)).toBe(compact);
		expect(uuidFormat(compact)).toBe(formatted);
	});

	it("calculates progress circle geometry", () => {
		const { circumference } = getProgressCircleConfig();

		expect(calculateStrokeDashoffset(25, circumference)).toBeCloseTo(
			circumference * 0.75,
		);
		expect(calculateStrokeDashoffset(100, circumference)).toBe(0);
	});

	it("prefers upload progress over processing progress", () => {
		expect(getDisplayProgress(42, 10)).toBe(42);
		expect(getDisplayProgress(undefined, 64)).toBe(64);
	});

	it("allows emails by exact address or domain restrictions", () => {
		expect(isEmailAllowedByRestriction("owner@cap.so", "")).toBe(true);
		expect(isEmailAllowedByRestriction("owner@cap.so", "cap.so")).toBe(true);
		expect(
			isEmailAllowedByRestriction("owner@cap.so", "admin@example.com"),
		).toBe(false);
		expect(
			isEmailAllowedByRestriction("admin@example.com", " admin@example.com "),
		).toBe(true);
	});
});
