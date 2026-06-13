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
	it("merges Tailwind classes with later conflicting classes winning", () => {
		expect(classNames("px-2 text-sm", false, "px-4")).toBe("text-sm px-4");
	});

	it("round-trips UUID formatting", () => {
		const uuid = "123e4567-e89b-12d3-a456-426614174000";

		expect(uuidFormat(uuidParse(uuid))).toBe(uuid);
	});

	it("calculates progress circle geometry", () => {
		const { radius, circumference } = getProgressCircleConfig();

		expect(radius).toBe(8);
		expect(circumference).toBe(2 * Math.PI * 8);
		expect(calculateStrokeDashoffset(25, circumference)).toBe(
			circumference * 0.75,
		);
	});

	it("prefers defined upload progress over processing progress", () => {
		expect(getDisplayProgress(42, 10)).toBe(42);
		expect(getDisplayProgress(0, 64)).toBe(0);
		expect(getDisplayProgress(undefined, 64)).toBe(64);
	});

	it("matches exact emails and domain restrictions", () => {
		expect(isEmailAllowedByRestriction("person@example.com", "")).toBe(true);
		expect(
			isEmailAllowedByRestriction(
				"person@example.com",
				"admin@example.com, example.com",
			),
		).toBe(true);
		expect(isEmailAllowedByRestriction("person@other.com", "example.com")).toBe(
			false,
		);
	});
});
