import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	invoke: vi.fn<(command: string, args?: object) => Promise<unknown>>(),
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
	invoke: fixture.invoke,
}));

vi.mock("./web-api", () => ({
	orgCustomDomainClient: {},
	protectedHeaders: vi.fn(),
}));

import { revealRecordingWindow } from "./queries";

beforeEach(() => {
	vi.resetAllMocks();
});

describe("recording window reveal bindings", () => {
	it("reveals the initial main window through the native capture guard", async () => {
		fixture.invoke
			.mockResolvedValueOnce({ generation: 0, phase: null })
			.mockResolvedValueOnce(true);

		await expect(revealRecordingWindow()).resolves.toBe(true);
		expect(fixture.invoke.mock.calls).toEqual([
			["get_clean_capture_state"],
			["reveal_capture_window", { generation: 0, targetOverlay: null }],
		]);
	});

	it("preserves a stale generation rejection without requesting a fresh reveal", async () => {
		fixture.invoke.mockResolvedValueOnce(false);

		await expect(revealRecordingWindow(7)).resolves.toBe(false);
		expect(fixture.invoke.mock.calls).toEqual([
			["reveal_capture_window", { generation: 7, targetOverlay: null }],
		]);
	});

	it("propagates native reveal failures", async () => {
		fixture.invoke.mockRejectedValueOnce(
			"Recording window closed before it could be shown",
		);

		await expect(revealRecordingWindow(0)).rejects.toBe(
			"Recording window closed before it could be shown",
		);
	});
});
