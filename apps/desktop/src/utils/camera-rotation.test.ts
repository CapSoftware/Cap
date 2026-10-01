import { describe, expect, it } from "vitest";
import {
	CAMERA_MIN_SIZE,
	CAMERA_TOOLBAR_WIDTH,
	cameraFrameTransform,
	cameraPreviewDimensions,
	cameraRotationSwapsAxes,
	cameraToolbarScale,
	getDefaultCameraWindowState,
	normalizeCameraRotation,
} from "../components/CameraPreviewChrome";

describe("camera rotation", () => {
	it("normalizes to quarter turns", () => {
		expect(normalizeCameraRotation(undefined)).toBe(0);
		expect(normalizeCameraRotation(90)).toBe(90);
		expect(normalizeCameraRotation(360)).toBe(0);
		expect(normalizeCameraRotation(-90)).toBe(270);
		expect(cameraRotationSwapsAxes(270)).toBe(true);
		expect(cameraRotationSwapsAxes(180)).toBe(false);
	});

	it("turns a landscape camera into a portrait preview", () => {
		const landscape = cameraPreviewDimensions(230, "full", 16 / 9, 0);
		expect(landscape.height).toBe(230);
		expect(landscape.width).toBeCloseTo((230 * 16) / 9);
		const portrait = cameraPreviewDimensions(230, "full", 16 / 9, 90);
		expect(portrait.width).toBe(230);
		expect(portrait.height).toBeCloseTo((230 * 16) / 9);
		expect(cameraPreviewDimensions(230, "round", 16 / 9, 90)).toEqual({
			height: 230,
			width: 230,
		});
	});

	it("mirrors after rotating", () => {
		expect(
			cameraFrameTransform({
				...getDefaultCameraWindowState(),
				mirrored: true,
				rotation: 90,
			}),
		).toBe("scaleX(-1) rotate(90deg)");
	});

	it("fits the toolbar inside the smallest preview", () => {
		const scale = cameraToolbarScale(CAMERA_MIN_SIZE);
		expect(CAMERA_TOOLBAR_WIDTH * scale).toBeLessThanOrEqual(CAMERA_MIN_SIZE);
	});
});
