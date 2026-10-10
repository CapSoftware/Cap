import { expect, test } from "vitest";
import {
	captureEditorLocalDraft,
	clearEditorLocalDraft,
	readEditorLocalDraft,
} from "../../lib/editor-local-draft";

function browserStorage(): Storage {
	const items = new Map<string, string>();
	return {
		get length() {
			return items.size;
		},
		clear: () => items.clear(),
		getItem: (key) => items.get(key) ?? null,
		key: (index) => [...items.keys()][index] ?? null,
		removeItem: (key) => items.delete(key),
		setItem: (key, value) => items.set(key, value),
	};
}

test("pending editor edits survive navigation only for their owner and recording", () => {
	const storage = browserStorage();
	const config = {
		timeline: {
			audioSegments: [{ path: "assets/audio/library-lofi-beats-mirostar.mp3" }],
		},
		captions: { segments: [{ id: "word", text: "Hello" }] },
	};
	expect(
		captureEditorLocalDraft(
			storage,
			"owner",
			"video",
			"2026-09-18T03:00:00.000Z",
			JSON.stringify(config),
		),
	).toBe(true);
	expect(readEditorLocalDraft(storage, "owner", "video")?.config).toEqual(
		config,
	);
	expect(readEditorLocalDraft(storage, "other", "video")).toBeNull();
	expect(readEditorLocalDraft(storage, "owner", "other")).toBeNull();
	clearEditorLocalDraft(storage, "owner", "video");
	expect(readEditorLocalDraft(storage, "owner", "video")).toBeNull();
});

test("a failed browser storage write cannot claim pending edits are safe", () => {
	const storage = browserStorage();
	storage.setItem = () => {
		throw new Error("Quota exceeded");
	};
	expect(
		captureEditorLocalDraft(
			storage,
			"owner",
			"video",
			null,
			JSON.stringify({ background: { padding: 12 } }),
		),
	).toBe(false);
	expect(readEditorLocalDraft(storage, "owner", "video")).toBeNull();
});

test("a large caption project survives the browser's local storage limit", () => {
	const storage = browserStorage();
	const setItem = storage.setItem;
	storage.setItem = (key, value) => {
		if (new TextEncoder().encode(value).byteLength > 4 * 1024 * 1024)
			throw new Error("Quota exceeded");
		setItem(key, value);
	};
	const config = {
		captions: {
			segments: Array.from({ length: 18_000 }, (_, index) => ({
				id: `word-${index}`,
				start: index / 10,
				end: (index + 1) / 10,
				text: "A résumé of the presentation with precise captions 🎥 ".repeat(
					7,
				),
			})),
		},
	};
	const serialized = JSON.stringify(config);
	expect(new TextEncoder().encode(serialized).byteLength).toBeGreaterThan(
		4 * 1024 * 1024,
	);
	expect(new TextEncoder().encode(serialized).byteLength).toBeLessThan(
		8 * 1024 * 1024,
	);
	expect(
		captureEditorLocalDraft(storage, "owner", "video", null, serialized),
	).toBe(true);
	expect(
		JSON.parse(storage.getItem(storage.key(0) ?? "") ?? "{}").version,
	).toBe(2);
	expect(readEditorLocalDraft(storage, "owner", "video")?.config).toEqual(
		config,
	);
});
