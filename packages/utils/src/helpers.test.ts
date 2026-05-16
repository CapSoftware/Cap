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
	it("parses and formats UUIDs", () => {
		const formatted = "123e4567-e89b-12d3-a456-426614174000";
		const compact = "123e4567e89b12d3a456426614174000";

		expect(uuidParse(formatted)).toBe(compact);
		expect(uuidFormat(compact)).toBe(formatted);
	});

	it("calculates circular progress values", () => {
		const { radius, circumference } = getProgressCircleConfig();

		expect(radius).toBe(8);
		expect(circumference).toBe(2 * Math.PI * 8);
		expect(calculateStrokeDashoffset(25, 80)).toBe(60);
	});

	it("prefers upload progress over processing progress", () => {
		expect(getDisplayProgress(42, 10)).toBe(42);
		expect(getDisplayProgress(undefined, 10)).toBe(10);
	});

	it("matches email restrictions by exact address or domain", () => {
		expect(isEmailAllowedByRestriction("Member@Cap.so", "member@cap.so")).toBe(
			true,
		);
		expect(isEmailAllowedByRestriction("hello@cap.so", "cap.so")).toBe(true);
		expect(isEmailAllowedByRestriction("hello@example.com", "cap.so")).toBe(
			false,
		);
		expect(isEmailAllowedByRestriction("hello@example.com", "")).toBe(true);
	});

	it("merges conditional Tailwind class names", () => {
		expect(classNames("px-2", "px-4", false && "hidden")).toBe("px-4");
	});
});
