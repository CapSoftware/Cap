import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	arch: vi.fn(() => "aarch64"),
	osType: vi.fn(() => "macos"),
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
		mocks.relaunch.mockResolvedValue(undefined);
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

	it("checks update safety before requesting an unpreventable restart", async () => {
		const { restartAfterUpdate } = await import("./updater");

		await restartAfterUpdate();

		expect(mocks.updatesDownloadAndInstall).toHaveBeenCalledOnce();
		expect(mocks.relaunch).toHaveBeenCalledOnce();
		expect(
			mocks.updatesDownloadAndInstall.mock.invocationCallOrder[0],
		).toBeLessThan(mocks.relaunch.mock.invocationCallOrder[0]);
	});

	it("does not restart while recording, exporting, or uploading is blocked", async () => {
		const error = new Error("Finish your recording, export, or upload first.");
		mocks.updatesDownloadAndInstall.mockRejectedValueOnce(error);
		const { restartAfterUpdate } = await import("./updater");

		await expect(restartAfterUpdate()).rejects.toBe(error);
		expect(mocks.relaunch).not.toHaveBeenCalled();
	});

	it("propagates a restart failure after a successful safety check", async () => {
		const error = new Error("Restart failed");
		mocks.relaunch.mockRejectedValueOnce(error);
		const { restartAfterUpdate } = await import("./updater");

		await expect(restartAfterUpdate()).rejects.toBe(error);
		expect(mocks.updatesDownloadAndInstall).toHaveBeenCalledOnce();
	});

	it("returns to GPUI through the guarded application handoff", async () => {
		const { returnToGpui } = await import("./updater");

		await returnToGpui();

		expect(mocks.switchToGpuiApp).toHaveBeenCalledOnce();
		expect(mocks.relaunch).not.toHaveBeenCalled();
	});

	it("does not return to GPUI while protected work is active", async () => {
		const error = new Error("Wait for your upload to finish.");
		mocks.switchToGpuiApp.mockRejectedValueOnce(error);
		const { returnToGpui } = await import("./updater");

		await expect(returnToGpui()).rejects.toBe(error);
		expect(mocks.relaunch).not.toHaveBeenCalled();
	});
});
