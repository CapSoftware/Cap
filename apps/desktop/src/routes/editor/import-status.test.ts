import { describe, expect, it } from "vitest";

import { deriveImportStatus, deriveRawImportStatus } from "./import-status";

describe("editor import status", () => {
	it("reports loading while the metadata query is still in flight", () => {
		expect(deriveRawImportStatus({ data: undefined, isError: false })).toBe(
			"loading",
		);
	});

	it("reports ready once metadata arrives", () => {
		expect(
			deriveRawImportStatus({ data: { status: null }, isError: false }),
		).toBe("ready");
	});

	it("reports importing while an import is in progress", () => {
		expect(
			deriveRawImportStatus({
				data: { status: { status: "InProgress" } },
				isError: false,
			}),
		).toBe("importing");
	});

	// #1812: a failed query also has no data. Before the fix this returned
	// "loading", so an unreadable recording-meta.json left the editor on the
	// skeleton with no error and no way forward.
	it("reports error when the metadata query fails", () => {
		expect(deriveRawImportStatus({ data: undefined, isError: true })).toBe(
			"error",
		);
	});

	it("still reports error when a stale success payload is present", () => {
		expect(
			deriveRawImportStatus({ data: { status: null }, isError: true }),
		).toBe("error");
	});

	it("keeps showing the import screen while the lock is held", () => {
		expect(deriveImportStatus("loading", true)).toBe("importing");
	});

	it("lets an error override the importing lock", () => {
		expect(deriveImportStatus("error", true)).toBe("error");
	});

	it("passes through the raw status when nothing is latched", () => {
		expect(deriveImportStatus("ready", false)).toBe("ready");
		expect(deriveImportStatus("loading", false)).toBe("loading");
	});
});
