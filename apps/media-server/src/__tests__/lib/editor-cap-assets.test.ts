import { expect, test } from "bun:test";
import { CAP_BUNDLE_CONTENT_TYPE } from "@cap/editor-cap-bundle";
import {
	type EditorCapAsset,
	validateEditorCapAsset,
} from "../../lib/editor-cap-assets";

const valid: EditorCapAsset = {
	path: "content/imports/00000000-0000-4000-8000-000000000000.capbundle",
	name: "Studio recording",
	url: "https://storage.cap.so/recording.capbundle",
	size: 1024,
	contentType: CAP_BUNDLE_CONTENT_TYPE,
	objectIdentity: '"recording-etag"',
};

test("accepts a bounded, signed Cap project source", () => {
	expect(() => validateEditorCapAsset(valid)).not.toThrow();
});

test("rejects project path, type, URL, size, and identity mismatches", () => {
	for (const invalid of [
		{ ...valid, path: "content/imports/../../source.capbundle" },
		{
			...valid,
			path: "content/videos/00000000-0000-4000-8000-000000000000.capbundle",
		},
		{ ...valid, contentType: "video/mp4" },
		{ ...valid, url: "http://localhost/private" },
		{ ...valid, url: "https://user:password@storage.cap.so/source" },
		{ ...valid, size: 0 },
		{ ...valid, size: 13 * 1024 * 1024 * 1024 },
		{ ...valid, objectIdentity: "" },
		{ ...valid, name: "../source" },
	]) {
		expect(() => validateEditorCapAsset(invalid)).toThrow();
	}
});
