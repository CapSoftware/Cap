import * as dialog from "@tauri-apps/plugin-dialog";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	confirmAndDiscardRecording,
	discardConfirmationMessage,
	formatRecordingSize,
} from "./recovery-discard";

vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn() }));

const recording = {
	projectPath: "/Volumes/CARD/cap/Cap 2026-09-28 at 16.01.52.cap",
	prettyName: "Cap 2026-09-28 at 16.01.52",
	totalBytes: 3.2 * 1024 * 1024 * 1024,
};

describe("discarding an incomplete recording", () => {
	beforeEach(() => vi.clearAllMocks());

	it("does not discard when the user cancels", async () => {
		vi.mocked(dialog.confirm).mockResolvedValue(false);
		const discard = vi.fn();

		await expect(confirmAndDiscardRecording(recording, discard)).resolves.toBe(
			false,
		);
		expect(discard).not.toHaveBeenCalled();
	});

	it("discards the confirmed recording once", async () => {
		vi.mocked(dialog.confirm).mockResolvedValue(true);
		const discard = vi.fn().mockResolvedValue(null);

		await expect(confirmAndDiscardRecording(recording, discard)).resolves.toBe(
			true,
		);
		expect(discard).toHaveBeenCalledTimes(1);
		expect(discard).toHaveBeenCalledWith(recording.projectPath);
	});

	it("warns that the deletion is permanent", async () => {
		vi.mocked(dialog.confirm).mockResolvedValue(false);

		await confirmAndDiscardRecording(recording, vi.fn());

		expect(dialog.confirm).toHaveBeenCalledWith(
			discardConfirmationMessage(recording),
			{
				title: "Discard incomplete recording",
				kind: "warning",
				okLabel: "Delete permanently",
				cancelLabel: "Cancel",
			},
		);
	});

	it("names the recording, its size and its location", () => {
		const message = discardConfirmationMessage(recording);

		expect(message).toContain(recording.prettyName);
		expect(message).toContain("3.2 GB");
		expect(message).toContain(recording.projectPath);
		expect(message).toContain("permanently deleted");
	});

	it("propagates a failed discard", async () => {
		vi.mocked(dialog.confirm).mockResolvedValue(true);
		const discard = vi.fn().mockRejectedValue("Failed to discard recording");

		await expect(confirmAndDiscardRecording(recording, discard)).rejects.toBe(
			"Failed to discard recording",
		);
	});
});

describe("recording size", () => {
	it.each([
		[0, "0 B"],
		[512, "512 B"],
		[1536, "1.5 KB"],
		[5 * 1024 * 1024, "5.0 MB"],
	])("formats %d bytes as %s", (bytes, expected) => {
		expect(formatRecordingSize(bytes)).toBe(expected);
	});
});
