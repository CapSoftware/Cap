import { describe, expect, it } from "vitest";
import { IMPORT_MAX_BYTES } from "@/lib/infra-video-import-limits";

describe("URL import size limit", () => {
	it("refuses imports over 1.5 GB", () => {
		expect(IMPORT_MAX_BYTES).toBe(1_500_000_000);
	});
});
