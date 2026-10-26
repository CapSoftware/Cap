import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileApiClient } from "@/api/mobile";
import {
	PhotosPermissionDeniedError,
	saveCapVideoToPhotos,
} from "./saveCapVideo";

const fileSystemMock = vi.hoisted(() => ({
	deleteAsync: vi.fn(),
	makeDirectoryAsync: vi.fn(),
	cacheDirectory: "file:///cache/" as string | null,
	documentDirectory: "file:///documents/",
	downloadAsync: vi.fn(),
}));

const mediaLibraryMock = vi.hoisted(() => ({
	requestPermissionsAsync: vi.fn(),
	saveToLibraryAsync: vi.fn(),
}));

vi.mock("expo-file-system/legacy", () => fileSystemMock);
vi.mock("expo-media-library", () => mediaLibraryMock);

const parentDirectory = (path: string) =>
	path.slice(0, path.lastIndexOf("/") + 1);

const makeClient = (fileName = "Cap.mp4") =>
	({
		getDownload: async () => ({ fileName, url: "https://cap.test/video" }),
	}) as unknown as MobileApiClient;

describe("saveCapVideoToPhotos", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		fileSystemMock.cacheDirectory = "file:///cache/";
		fileSystemMock.downloadAsync
			.mockReset()
			.mockImplementation(async (_url: string, target: string) => ({
				uri: target,
				status: 200,
			}));
		fileSystemMock.deleteAsync.mockResolvedValue(undefined);
		fileSystemMock.makeDirectoryAsync.mockResolvedValue(undefined);
		mediaLibraryMock.requestPermissionsAsync.mockResolvedValue({
			granted: true,
		});
		mediaLibraryMock.saveToLibraryAsync.mockResolvedValue(undefined);
	});

	it("saves the downloaded file to the photo library and deletes the temp file", async () => {
		const getDownload = vi.fn(async () => ({
			fileName: "Launch demo.mp4",
			url: "https://cap.so/download.mp4",
		}));

		const result = await saveCapVideoToPhotos(
			{ getDownload } as unknown as MobileApiClient,
			"cap-123",
		);

		expect(result).toBe("Launch demo.mp4");
		expect(fileSystemMock.downloadAsync).toHaveBeenCalledWith(
			"https://cap.so/download.mp4",
			expect.stringMatching(
				/^file:\/\/\/cache\/cap-download-.*\/Launch demo\.mp4$/,
			),
		);
		expect(mediaLibraryMock.saveToLibraryAsync).toHaveBeenCalledWith(
			expect.stringMatching(
				/^file:\/\/\/cache\/cap-download-.*\/Launch demo\.mp4$/,
			),
		);
		expect(fileSystemMock.deleteAsync).toHaveBeenCalledWith(
			expect.stringMatching(/^file:\/\/\/cache\/cap-download-[^/]+\/$/),
			{ idempotent: true },
		);
	});

	it("deletes the temp file when saving to the photo library fails", async () => {
		const getDownload = vi.fn(async () => ({
			fileName: "Launch demo.mp4",
			url: "https://cap.so/download.mp4",
		}));
		mediaLibraryMock.saveToLibraryAsync.mockRejectedValueOnce(
			new Error("photo library failed"),
		);

		await expect(
			saveCapVideoToPhotos(
				{ getDownload } as unknown as MobileApiClient,
				"cap-123",
			),
		).rejects.toThrow("photo library failed");

		expect(fileSystemMock.deleteAsync).toHaveBeenCalledWith(
			expect.stringMatching(/^file:\/\/\/cache\/cap-download-[^/]+\/$/),
			{ idempotent: true },
		);
	});

	it("does not download without photo library permission", async () => {
		mediaLibraryMock.requestPermissionsAsync.mockResolvedValueOnce({
			granted: false,
		});

		await expect(
			saveCapVideoToPhotos(
				{ getDownload: vi.fn() } as unknown as MobileApiClient,
				"cap-123",
			),
		).rejects.toBeInstanceOf(PhotosPermissionDeniedError);

		expect(fileSystemMock.downloadAsync).not.toHaveBeenCalled();
		expect(fileSystemMock.deleteAsync).not.toHaveBeenCalled();
	});

	it.each([".", "..", "/"])(
		"keeps the sanitized name %s inside its temporary directory",
		async (fileName) => {
			await saveCapVideoToPhotos(makeClient(fileName), "cap-123");
			expect(fileSystemMock.downloadAsync).toHaveBeenCalledWith(
				"https://cap.test/video",
				expect.stringMatching(
					/^file:\/\/\/cache\/cap-download-[^/]+\/Cap\.mp4$/,
				),
			);
		},
	);

	it("uses a private document subdirectory when the cache directory is unavailable", async () => {
		fileSystemMock.cacheDirectory = null;
		await saveCapVideoToPhotos(makeClient(), "cap-123");
		expect(fileSystemMock.downloadAsync).toHaveBeenCalledWith(
			"https://cap.test/video",
			expect.stringMatching(
				/^file:\/\/\/documents\/cap-download-[^/]+\/Cap\.mp4$/,
			),
		);
	});

	it("does not create temporary files when the download API fails", async () => {
		const client = makeClient();
		client.getDownload = async () => {
			throw new Error("Cap unavailable");
		};
		await expect(saveCapVideoToPhotos(client, "cap-123")).rejects.toThrow(
			"Cap unavailable",
		);
		expect(fileSystemMock.makeDirectoryAsync).not.toHaveBeenCalled();
		expect(fileSystemMock.deleteAsync).not.toHaveBeenCalled();
	});

	it.each([403, 404, 500])(
		"does not save an HTTP %s response to Photos",
		async (status) => {
			fileSystemMock.downloadAsync.mockImplementationOnce(
				async (_url: string, target: string) => ({ uri: target, status }),
			);
			await expect(
				saveCapVideoToPhotos(makeClient(), "cap-123"),
			).rejects.toThrow(`HTTP ${status}`);
			expect(mediaLibraryMock.saveToLibraryAsync).not.toHaveBeenCalled();
			expect(fileSystemMock.deleteAsync).toHaveBeenCalledWith(
				parentDirectory(fileSystemMock.downloadAsync.mock.calls[0]?.[1]),
				{ idempotent: true },
			);
		},
	);

	it("cleans a partial download when the native download fails", async () => {
		fileSystemMock.downloadAsync.mockRejectedValueOnce(
			new Error("Connection lost"),
		);
		await expect(saveCapVideoToPhotos(makeClient(), "cap-123")).rejects.toThrow(
			"Connection lost",
		);
		expect(mediaLibraryMock.saveToLibraryAsync).not.toHaveBeenCalled();
		expect(fileSystemMock.deleteAsync).toHaveBeenCalledWith(
			parentDirectory(fileSystemMock.downloadAsync.mock.calls[0]?.[1]),
			{ idempotent: true },
		);
	});

	it("preserves the Photos failure when temporary-file deletion also fails", async () => {
		mediaLibraryMock.saveToLibraryAsync.mockRejectedValueOnce(
			new Error("Photos unavailable"),
		);
		fileSystemMock.deleteAsync.mockRejectedValueOnce(
			new Error("Delete failed"),
		);
		await expect(saveCapVideoToPhotos(makeClient(), "cap-123")).rejects.toThrow(
			"Photos unavailable",
		);
	});

	it("returns a saved video's name even if best-effort cleanup fails", async () => {
		fileSystemMock.deleteAsync.mockRejectedValueOnce(
			new Error("Delete failed"),
		);
		await expect(saveCapVideoToPhotos(makeClient(), "cap-123")).resolves.toBe(
			"Cap.mp4",
		);
		expect(mediaLibraryMock.saveToLibraryAsync).toHaveBeenCalledOnce();
	});

	it("keeps overlapping saves of the same filename in separate cache files", async () => {
		const release: (() => void)[] = [];
		mediaLibraryMock.saveToLibraryAsync.mockImplementation(
			() => new Promise<void>((resolve) => release.push(resolve)),
		);
		fileSystemMock.downloadAsync.mockImplementation(
			async (_url: string, target: string) => ({ uri: target, status: 200 }),
		);
		const client = makeClient();
		const first = saveCapVideoToPhotos(client, "first");
		const second = saveCapVideoToPhotos(client, "second");
		try {
			await vi.waitFor(() => expect(release).toHaveLength(2));
		} finally {
			for (const resolve of release) resolve();
			await Promise.all([first, second]);
		}
		const targets = fileSystemMock.downloadAsync.mock.calls.map(
			(call) => call[1],
		);
		expect(targets[0]).not.toBe(targets[1]);
		for (const target of targets) {
			expect(target).toMatch(/^file:\/\/\/cache\/.*Cap\.mp4$/);
			expect(fileSystemMock.deleteAsync).toHaveBeenCalledWith(
				parentDirectory(target),
				{
					idempotent: true,
				},
			);
		}
	});
});
