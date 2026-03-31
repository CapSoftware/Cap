import { describe, expect, it, vi } from "vitest";

import {
	isPermissionGranted,
	permissionStatusFor,
	requestAndVerifyPermission,
} from "~/utils/os-permissions";

describe("os-permissions", () => {
	it("treats only granted and not-needed statuses as permitted", () => {
		expect(isPermissionGranted("granted")).toBe(true);
		expect(isPermissionGranted("notNeeded")).toBe(true);
		expect(isPermissionGranted("empty")).toBe(false);
		expect(isPermissionGranted("denied")).toBe(false);
	});

	it("maps a permission key to the matching OS permission status", () => {
		const check = {
			screenRecording: "granted",
			microphone: "empty",
			camera: "denied",
			accessibility: "notNeeded",
		} as const;

		expect(permissionStatusFor(check, "screenRecording")).toBe("granted");
		expect(permissionStatusFor(check, "microphone")).toBe("empty");
		expect(permissionStatusFor(check, "camera")).toBe("denied");
		expect(permissionStatusFor(check, "accessibility")).toBe("notNeeded");
	});

	it("does not open settings after a successful permission request", async () => {
		const client = {
			requestPermission: vi.fn().mockResolvedValue(undefined),
			openPermissionSettings: vi.fn().mockResolvedValue(undefined),
			doPermissionsCheck: vi.fn().mockResolvedValue({
				screenRecording: "empty",
				microphone: "granted",
				camera: "empty",
				accessibility: "empty",
			}),
		};

		const result = await requestAndVerifyPermission(client, "microphone");

		expect(client.requestPermission).toHaveBeenCalledWith("microphone");
		expect(client.openPermissionSettings).not.toHaveBeenCalled();
		expect(result.status).toBe("granted");
		expect(result.openedSettings).toBe(false);
	});

	it("opens settings when the OS still reports the permission as ungranted", async () => {
		const client = {
			requestPermission: vi.fn().mockResolvedValue(undefined),
			openPermissionSettings: vi.fn().mockResolvedValue(undefined),
			doPermissionsCheck: vi.fn().mockResolvedValue({
				screenRecording: "denied",
				microphone: "empty",
				camera: "empty",
				accessibility: "empty",
			}),
		};

		const result = await requestAndVerifyPermission(client, "screenRecording");

		expect(client.requestPermission).toHaveBeenCalledWith("screenRecording");
		expect(client.openPermissionSettings).toHaveBeenCalledWith(
			"screenRecording",
		);
		expect(result.status).toBe("denied");
		expect(result.openedSettings).toBe(true);
	});

	it("skips the native request and goes straight to settings for denied permissions", async () => {
		const client = {
			requestPermission: vi.fn().mockResolvedValue(undefined),
			openPermissionSettings: vi.fn().mockResolvedValue(undefined),
			doPermissionsCheck: vi.fn().mockResolvedValue({
				screenRecording: "empty",
				microphone: "empty",
				camera: "empty",
				accessibility: "denied",
			}),
		};

		const result = await requestAndVerifyPermission(
			client,
			"accessibility",
			"denied",
		);

		expect(client.requestPermission).not.toHaveBeenCalled();
		expect(client.openPermissionSettings).toHaveBeenCalledWith("accessibility");
		expect(result.status).toBe("denied");
		expect(result.openedSettings).toBe(true);
	});
});
