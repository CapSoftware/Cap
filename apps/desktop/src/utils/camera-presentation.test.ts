import { describe, expect, it } from "vitest";
import {
	type CameraPresentationMeasurement,
	cameraPresentationInput,
} from "./camera-presentation";
import type { CameraPreviewState } from "./tauri";

const state: CameraPreviewState = {
	size: 230,
	shape: "round",
	mirrored: true,
	background_blur: "heavy",
};
const measurement: CameraPresentationMeasurement = {
	viewportWidth: 230,
	viewportHeight: 286,
	left: 0,
	top: 56,
	width: 230,
	height: 230,
	cornerRadii: ["9999px", "9999px", "9999px", "9999px"],
};

describe("Linux legacy camera presentation", () => {
	it("measures content below the toolbar and preserves exact requested effects", () => {
		const actual = cameraPresentationInput(measurement, state, 7);
		expect(actual.top).toBe(56);
		expect(actual.height).toBe(230);
		expect(actual.radius).toBe(115);
		expect(actual.state).toEqual(state);
		expect(actual.layoutRevision).toBe(7);
	});

	it("uses actual full-shape dimensions and inner clipping rather than outer radius", () => {
		const actual = cameraPresentationInput(
			{
				...measurement,
				viewportWidth: 460,
				width: 460,
				cornerRadii: ["24px", "24px", "24px", "24px"],
			},
			{ ...state, shape: "full" },
			8,
		);
		expect(actual.width).toBe(460);
		expect(actual.radius).toBe(24);
	});

	it("keeps fractional CSS coordinates for native physical scaling", () => {
		const actual = cameraPresentationInput(
			{
				...measurement,
				viewportWidth: 231,
				left: 0.5,
				width: 230.25,
				height: 230.25,
				viewportHeight: 287,
			},
			state,
			1,
		);
		expect(actual.left).toBe(0.5);
		expect(actual.width).toBe(230.25);
	});

	it("rejects absent, nonfinite, negative or outside content geometry", () => {
		for (const invalid of [
			{ width: 0 },
			{ left: -1 },
			{ top: Number.NaN },
			{ width: Number.POSITIVE_INFINITY },
			{ top: 100 },
		]) {
			expect(() =>
				cameraPresentationInput({ ...measurement, ...invalid }, state, 1),
			).toThrow();
		}
	});

	it("rejects unknown, asymmetric and elliptical clipping", () => {
		for (const cornerRadii of [
			["calc(2px)", "24px", "24px", "24px"],
			["12px", "24px", "24px", "24px"],
			["24px 12px", "24px", "24px", "24px"],
		] as const) {
			expect(() =>
				cameraPresentationInput({ ...measurement, cornerRadii }, state, 1),
			).toThrow();
		}
	});

	it("accepts measured percentage circles but rejects a non-square round preview", () => {
		expect(
			cameraPresentationInput(
				{ ...measurement, cornerRadii: ["50%", "50%", "50%", "50%"] },
				state,
				1,
			).radius,
		).toBe(115);
		expect(() =>
			cameraPresentationInput({ ...measurement, width: 220 }, state, 1),
		).toThrow();
	});

	it("does not rewrite stored state or share its mutable object", () => {
		const actual = cameraPresentationInput(measurement, state, 1);
		actual.state.mirrored = false;
		expect(state.mirrored).toBe(true);
		for (const mode of ["off", "light", "heavy"] as const) {
			expect(
				cameraPresentationInput(
					measurement,
					{ ...state, background_blur: mode },
					1,
				).state.background_blur,
			).toBe(mode);
		}
	});

	it("rejects invalid layout revisions", () => {
		for (const revision of [-1, 1.5, Number.NaN, 0x1_0000_0000]) {
			expect(() =>
				cameraPresentationInput(measurement, state, revision),
			).toThrow();
		}
	});
});
