import { describe, expect, it } from "vitest";
import {
	INFRA_TRANSCRIPT_LABELS,
	infraTranscriptDisplayState,
} from "@/lib/infra-transcript-view";

describe("what a transcript row says", () => {
	it("shows the server's status once the file is in", () => {
		for (const status of [
			"queued",
			"processing",
			"complete",
			"error",
		] as const) {
			for (const local of ["sending", "sent", null] as const) {
				expect(infraTranscriptDisplayState(status, local)).toBe(status);
			}
		}
	});

	it("says uploading while this tab is sending the file", () => {
		expect(infraTranscriptDisplayState("uploading", "sending")).toBe(
			"uploading",
		);
		expect(INFRA_TRANSCRIPT_LABELS.uploading).toBe("Uploading");
	});

	it("says queued once the server accepted the file, before the list catches up", () => {
		expect(infraTranscriptDisplayState("uploading", "sent")).toBe("queued");
	});

	it("calls an upload nobody is sending unfinished, never waiting", () => {
		expect(infraTranscriptDisplayState("uploading", null)).toBe("unfinished");
		expect(INFRA_TRANSCRIPT_LABELS.unfinished).toBe("Upload not finished");
		expect(Object.values(INFRA_TRANSCRIPT_LABELS)).not.toContain(
			"Waiting for file",
		);
	});
});
