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
	it("merges conditional class names and resolves Tailwind conflicts", () => {
		expect(classNames("p-2", false && "hidden", "p-4", ["text-sm"])).toBe(
			"p-4 text-sm",
		);
	});

	it("round-trips UUIDs between dashed and compact forms", () => {
		const dashed = "123e4567-e89b-12d3-a456-426614174000";
		const compact = "123e4567e89b12d3a456426614174000";

		expect(uuidParse(dashed)).toBe(compact);
		expect(uuidFormat(compact)).toBe(dashed);
	});

	it("keeps zero upload progress as the displayed progress", () => {
		expect(getDisplayProgress(0, 75)).toBe(0);
		expect(getDisplayProgress(undefined, 75)).toBe(75);
	});

	it("calculates circular progress stroke offsets", () => {
		const { circumference } = getProgressCircleConfig();

		expect(calculateStrokeDashoffset(0, circumference)).toBe(circumference);
		expect(calculateStrokeDashoffset(100, circumference)).toBe(0);
	});

	it("allows exact emails and domain restrictions case-insensitively", () => {
		expect(
			isEmailAllowedByRestriction(
				"Founders@Cap.so",
				"team@example.com, cap.so",
			),
		).toBe(true);
		expect(
			isEmailAllowedByRestriction(
				"team@example.com",
				"team@example.com, cap.so",
			),
		).toBe(true);
		expect(
			isEmailAllowedByRestriction("team@other.com", "team@example.com, cap.so"),
		).toBe(false);
	});
});
