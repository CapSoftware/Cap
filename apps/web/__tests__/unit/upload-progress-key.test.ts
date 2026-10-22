import { describe, expect, it } from "vitest";
import { uploadProgressKey } from "@/app/s/[videoId]/_components/upload-progress";

describe("uploadProgressKey", () => {
	it("matches separate objects with the same value", () => {
		const at = 1_790_000_000_000;
		expect(
			uploadProgressKey({
				status: "uploading",
				lastUpdated: new Date(at),
				progress: 40,
			}),
		).toBe(
			uploadProgressKey({
				status: "uploading",
				lastUpdated: new Date(at),
				progress: 40,
			}),
		);
		expect(uploadProgressKey({ status: "fetching" })).toBe(
			uploadProgressKey({ status: "fetching" }),
		);
	});

	it("changes with the progress, the time or the state", () => {
		const base = {
			status: "processing" as const,
			lastUpdated: new Date(1_790_000_000_000),
			progress: 10,
			message: null,
		};
		const key = uploadProgressKey(base);
		expect(uploadProgressKey({ ...base, progress: 11 })).not.toBe(key);
		expect(
			uploadProgressKey({ ...base, lastUpdated: new Date(1_790_000_001_000) }),
		).not.toBe(key);
		expect(uploadProgressKey({ ...base, message: "Encoding" })).not.toBe(key);
		expect(uploadProgressKey(null)).not.toBe(key);
	});
});
