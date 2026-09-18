import { gzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { editTranscriptToEditorCaptions } from "../lib/editor-captions";
import {
	decodeWebEditorProject,
	encodeWebEditorProject,
	MAX_WEB_EDITOR_CONFIG_BYTES,
} from "../lib/editor-project-storage";

test("a two-hour word-level caption project survives compact save and reopen", () => {
	const words = Array.from({ length: 18_000 }, (_, index) => ({
		id: `word-${index}`,
		text: index % 7 === 0 ? "recording" : "process",
		startMs: index * 400,
		endMs: index * 400 + 240,
		confidence: null,
		speaker: null,
		channel: null,
	}));
	const captions = editTranscriptToEditorCaptions({
		version: 3,
		speechModelUsed: "universal-3-pro",
		durationMs: 7_200_000,
		languageCode: "en",
		words,
	});
	const config = {
		captions: { ...captions, sourceTimed: true },
		timeline: { captionSegments: captions.segments },
	};
	const { project, serialized } = encodeWebEditorProject(config);
	expect(Buffer.byteLength(serialized, "utf8")).toBeGreaterThan(512 * 1024);
	expect(project.version).toBe(2);
	if (project.version !== 2) throw new Error("Invalid stored project version");
	expect(project.configGzipBase64.length).toBeLessThan(serialized.length);
	expect(decodeWebEditorProject(project)).toEqual(config);
});

test("compressed project decoding rejects corruption and decompression bombs", () => {
	const { project } = encodeWebEditorProject({ camera: { mirror: true } });
	if (project.version !== 2) throw new Error("Invalid stored project version");
	expect(
		decodeWebEditorProject({ ...project, configGzipBase64: "not-base64" }),
	).toBeNull();
	const bomb = gzipSync(Buffer.alloc(MAX_WEB_EDITOR_CONFIG_BYTES + 1, 65));
	expect(
		decodeWebEditorProject({
			...project,
			configGzipBase64: bomb.toString("base64"),
			uncompressedBytes: MAX_WEB_EDITOR_CONFIG_BYTES,
		}),
	).toBeNull();
	expect(() =>
		encodeWebEditorProject({ data: "a".repeat(MAX_WEB_EDITOR_CONFIG_BYTES) }),
	).toThrow("too large");
});

test("existing uncompressed editor projects remain readable", () => {
	const config = { timeline: { segments: [] } };
	expect(
		decodeWebEditorProject({
			version: 1,
			config,
			savedAt: "2026-09-17T10:00:00.000Z",
		}),
	).toEqual(config);
});
