import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CameraSelector } from "./camera-selector";

const camera = { deviceId: "camera-1", label: "Camera", groupId: "group-1" };

const renderStatusButton = (disabled: boolean, permissionGranted: boolean) => {
	const markup = renderToStaticMarkup(
		<CameraSelector
			selectedCameraId={camera.deviceId}
			availableCameras={permissionGranted ? [camera] : []}
			permissionGranted={permissionGranted}
			disabled={disabled}
			onCameraChange={() => undefined}
			onRefreshDevices={() => undefined}
			onPermissionBlocked={() => undefined}
		/>,
	);
	return markup.match(/<button[^>]*aria-disabled="[^"]*"[^>]*>/)?.[0];
};

describe("camera selector", () => {
	it.each([true, false])(
		"disables the status button when the selector is disabled and permission is %s",
		(permissionGranted) => {
			const button = renderStatusButton(true, permissionGranted);

			expect(button).toMatch(/\sdisabled=/);
			expect(button).toMatch(/aria-disabled="true"/);
		},
	);

	it("keeps the status button available when the selector is enabled", () => {
		const button = renderStatusButton(false, true);
		expect(button).not.toMatch(/\sdisabled=/);
		expect(button).toMatch(/aria-disabled="false"/);
	});
});
