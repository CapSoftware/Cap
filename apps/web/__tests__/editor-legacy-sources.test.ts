import { Database, Storage } from "@cap/web-backend";
import { Effect } from "effect";
import { afterEach, expect, test, vi } from "vitest";
import { getSignedEditorSources } from "../lib/editor-session";

const storage = vi.hoisted(() => ({
	head: vi.fn(),
	signed: vi.fn(),
	accessOptions: vi.fn(),
	legacyEdit: null as null | {
		sourceKey: string;
		editSpec: {
			version: 1;
			sourceDuration: number;
			keepRanges: Array<{ start: number; end: number }>;
		};
	},
}));

vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: () => ({ id: "video" }),
}));

type EditorVideo = Parameters<typeof getSignedEditorSources>[0];

function video(metadata: unknown): EditorVideo {
	return {
		id: "video",
		ownerId: "owner",
		name: "Older recording",
		fps: 30,
		source: { type: "webMP4" },
		metadata,
	} as EditorVideo;
}

function signedSources(editorVideo: EditorVideo) {
	const access = {
		headObject: (key: string) => Effect.succeed(storage.head(key)),
		getInternalSignedObjectUrl: (key: string) =>
			Effect.succeed(storage.signed(key)),
	};
	const service = {
		getAccessForVideo: (_video: unknown, options: unknown) => {
			storage.accessOptions(options);
			return Effect.succeed([access]);
		},
	} as unknown as Storage;
	const database = Database.make({
		use: (callback) =>
			Effect.promise(() =>
				callback({
					select: () => ({
						from: () => ({
							where: async () =>
								storage.legacyEdit ? [storage.legacyEdit] : [],
						}),
					}),
				} as unknown as Parameters<typeof callback>[0]),
			),
	});
	return Effect.runPromise(
		getSignedEditorSources(editorVideo).pipe(
			Effect.provideService(Storage, service),
			Effect.provideService(Database, database),
		),
	);
}

afterEach(() => {
	vi.clearAllMocks();
	storage.legacyEdit = null;
});

test("a previously trimmed recording opens the immutable original with its saved cuts", async () => {
	const originalKey = "owner/video/source/original.mp4";
	storage.legacyEdit = {
		sourceKey: originalKey,
		editSpec: {
			version: 1,
			sourceDuration: 12,
			keepRanges: [
				{ start: 1, end: 4 },
				{ start: 7, end: 11 },
			],
		},
	};
	storage.head.mockReturnValue({ ContentLength: 4321, ETag: '"original"' });
	storage.signed.mockReturnValue("https://storage.example/original");
	const result = await signedSources(video(null));
	expect(storage.head).toHaveBeenCalledExactlyOnceWith(originalKey);
	expect(storage.signed).toHaveBeenCalledExactlyOnceWith(originalKey);
	expect(result.display).toMatchObject({
		url: "https://storage.example/original",
		size: 4321,
		objectIdentity: '"original"',
	});
	expect(result.legacyEditSpec).toEqual(storage.legacyEdit.editSpec);
	expect("camera" in result).toBe(false);
});

test("an older recording opens from its verified published MP4", async () => {
	const key = "owner/video/result.mp4";
	storage.head.mockReturnValue({
		ContentLength: 1234,
		ETag: JSON.stringify("published"),
	});
	storage.signed.mockReturnValue("https://storage.example/published");
	const result = await signedSources(video(null));
	expect(storage.accessOptions).toHaveBeenCalledWith({
		resolvePublishedOutput: false,
	});
	expect(storage.head).toHaveBeenCalledExactlyOnceWith(key);
	expect(storage.signed).toHaveBeenCalledExactlyOnceWith(key);
	expect(result.display).toEqual({
		url: "https://storage.example/published",
		contentType: "video/mp4",
		size: 1234,
		fps: 30,
		objectIdentity: '"published"',
	});
	expect("camera" in result).toBe(false);
});

test("an unverified legacy output cannot be opened in the editor", async () => {
	storage.head.mockReturnValue({ ContentLength: 0, ETag: '"empty"' });
	await expect(signedSources(video(null))).rejects.toThrow();
	expect(storage.signed).not.toHaveBeenCalled();
});

test("a new recording still uses its separate preserved screen and camera objects", async () => {
	const displayKey = "owner/video/raw-upload.webm";
	const cameraKey = "owner/video/camera-upload.webm";
	storage.head.mockImplementation((key: string) => ({
		ContentLength: key === displayKey ? 1234 : 456,
		ETag: key === displayKey ? '"screen"' : '"camera"',
	}));
	storage.signed.mockImplementation(
		(key: string) => `https://storage.example/${key}`,
	);
	const result = await signedSources(
		video({
			editorSources: {
				version: 1,
				display: {
					key: displayKey,
					contentType: "video/webm",
					size: 1234,
					objectIdentity: '"screen"',
				},
				camera: {
					key: cameraKey,
					contentType: "video/webm",
					size: 456,
					objectIdentity: '"camera"',
					offsetMs: 125,
				},
			},
		}),
	);
	expect(storage.accessOptions).toHaveBeenCalledWith({
		resolvePublishedOutput: false,
	});
	expect(storage.head.mock.calls.map(([key]) => key)).toEqual([
		displayKey,
		cameraKey,
	]);
	expect(result.camera).toMatchObject({
		url: `https://storage.example/${cameraKey}`,
		size: 456,
		offsetMs: 125,
		objectIdentity: '"camera"',
	});
});

test("Free preparation keeps the video edits but removes saved Pro captions", async () => {
	storage.head.mockReturnValue({
		ContentLength: 1234,
		ETag: JSON.stringify("published"),
	});
	storage.signed.mockReturnValue("https://storage.example/published");
	const saved = {
		webEditorProject: {
			version: 1,
			config: {
				camera: { mirror: true },
				captions: {
					segments: [{ text: "Paid" }],
					settings: { enabled: true, exportWithSubtitles: true },
				},
				timeline: { captionSegments: [{ text: "Paid" }] },
			},
		},
	};
	const free = await signedSources(video(saved));
	expect(free.captionsEnabled).toBe(false);
	expect(free.projectConfig).toMatchObject({
		camera: { mirror: true },
		captions: {
			segments: [],
			settings: { enabled: false, exportWithSubtitles: false },
		},
		timeline: { captionSegments: [] },
	});
	const pro = await signedSources({ ...video(saved), captionsEnabled: true });
	expect(pro.captionsEnabled).toBe(true);
	expect(pro.projectConfig).toMatchObject({
		captions: { segments: [{ text: "Paid" }] },
	});
});
