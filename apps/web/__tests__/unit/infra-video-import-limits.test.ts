import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES } from "@/lib/infra-upload";
import { IMPORT_MAX_BYTES } from "@/lib/infra-video-import-limits";

describe("URL import size limit", () => {
	it("takes a file as large as an upload, since the download no longer holds it in memory", () => {
		expect(IMPORT_MAX_BYTES).toBe(MAX_UPLOAD_BYTES);
	});
});
