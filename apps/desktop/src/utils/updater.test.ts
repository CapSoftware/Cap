import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	arch: vi.fn(() => "aarch64"),
	osType: vi.fn(() => "macos"),
	restartApp: vi.fn(async () => undefined),
	relaunch: vi.fn(async () => undefined),
	switchToGpuiApp: vi.fn(async () => undefined),
	updatesDownloadAndInstall: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/plugin-os", () => ({
	arch: mocks.arch,
	type: mocks.osType,
}));

vi.mock("@tauri-apps/plugin-process", () => ({
	relaunch: mocks.relaunch,
}));

vi.mock("~/utils/tauri", () => ({
	commands: {
		restartApp: mocks.restartApp,
		switchToGpuiApp: mocks.switchToGpuiApp,
		updatesDownloadAndInstall: mocks.updatesDownloadAndInstall,
	},
}));

describe("updater", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.arch.mockReturnValue("aarch64");
		mocks.osType.mockReturnValue("macos");
		mocks.updatesDownloadAndInstall.mockResolvedValue(undefined);
		mocks.switchToGpuiApp.mockResolvedValue(undefined);
		mocks.restartApp.mockResolvedValue(undefined);
	});

	it.each([
		{ os: "macos", arch: "aarch64", target: "darwin-aarch64" },
		{ os: "linux", arch: "x86_64", target: "linux-x86_64-deb" },
		{ os: "windows", arch: "x86", target: "windows-i686" },
	])("uses the expected updater target for $os on $arch", async (platform) => {
		mocks.arch.mockReturnValue(platform.arch);
		mocks.osType.mockReturnValue(platform.os);
		const { getUpdaterCheckOptions } = await import("./updater");

		expect(getUpdaterCheckOptions()).toEqual({ target: platform.target });
	});

	it("checks update safety before the final guarded restart admission", async () => {
		const { restartAfterUpdate } = await import("./updater");

		await restartAfterUpdate();

		expect(mocks.updatesDownloadAndInstall).toHaveBeenCalledOnce();
		expect(mocks.restartApp).toHaveBeenCalledOnce();
		expect(
			mocks.updatesDownloadAndInstall.mock.invocationCallOrder[0],
		).toBeLessThan(mocks.restartApp.mock.invocationCallOrder[0]);
	});

	it("does not restart while recording, exporting, or uploading is blocked", async () => {
		const error = new Error("Finish your recording, export, or upload first.");
		mocks.updatesDownloadAndInstall.mockRejectedValueOnce(error);
		const { restartAfterUpdate } = await import("./updater");

		await expect(restartAfterUpdate()).rejects.toBe(error);
		expect(mocks.restartApp).not.toHaveBeenCalled();
	});

	it("propagates a restart failure after a successful safety check", async () => {
		const error = new Error("Restart failed");
		mocks.restartApp.mockRejectedValueOnce(error);
		const { restartAfterUpdate } = await import("./updater");

		await expect(restartAfterUpdate()).rejects.toBe(error);
		expect(mocks.updatesDownloadAndInstall).toHaveBeenCalledOnce();
		expect(mocks.relaunch).not.toHaveBeenCalled();
	});

	it("retries guarded restart after a post-install recording refusal without raw relaunch", async () => {
		const error = "Recording started after the update was installed.";
		mocks.restartApp.mockRejectedValueOnce(error);
		const { restartAfterUpdate } = await import("./updater");

		await expect(restartAfterUpdate()).rejects.toBe(error);
		expect(mocks.relaunch).not.toHaveBeenCalled();
		await expect(restartAfterUpdate()).resolves.toBeUndefined();
		expect(mocks.restartApp).toHaveBeenCalledTimes(2);
		expect(mocks.updatesDownloadAndInstall).toHaveBeenCalledTimes(2);
		expect(mocks.relaunch).not.toHaveBeenCalled();
	});

	it("returns to GPUI through the guarded application handoff", async () => {
		const { returnToGpui } = await import("./updater");

		await returnToGpui();

		expect(mocks.switchToGpuiApp).toHaveBeenCalledOnce();
		expect(mocks.restartApp).not.toHaveBeenCalled();
	});

	it("does not return to GPUI while protected work is active", async () => {
		const error = new Error("Wait for your upload to finish.");
		mocks.switchToGpuiApp.mockRejectedValueOnce(error);
		const { returnToGpui } = await import("./updater");

		await expect(returnToGpui()).rejects.toBe(error);
		expect(mocks.restartApp).not.toHaveBeenCalled();
	});
});
