import { describe, expect, it } from "vitest";
import { contentTypeForUpload, contentTypeFromName } from "./fileTypes";

describe("mobile upload file type inference", () => {
	it.each([
		["demo.mp4", "video/mp4"],
		["demo.mov", "video/quicktime"],
		["demo.webm", "video/webm"],
		["demo.mkv", "video/x-matroska"],
		["demo.avi", "video/x-msvideo"],
		["demo.m4v", "video/x-m4v"],
	])("infers %s as %s", (name, contentType) => {
		expect(contentTypeFromName(name)).toBe(contentType);
	});

	it("keeps picker-provided video content types", () => {
		expect(contentTypeForUpload("demo.mkv", "video/custom")).toBe(
			"video/custom",
		);
	});

	it("falls back to the filename when the picker returns an opaque type", () => {
		expect(contentTypeForUpload("demo.mkv", "application/octet-stream")).toBe(
			"video/x-matroska",
		);
	});
});
