import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileApiClient } from "@/api/mobile";
import {
	PhotosPermissionDeniedError,
	saveCapVideoToPhotos,
} from "./saveCapVideo";

const fileSystemMock = vi.hoisted(() => ({
	deleteAsync: vi.fn(),
	documentDirectory: "file:///documents/",
	downloadAsync: vi.fn(),
}));

const mediaLibraryMock = vi.hoisted(() => ({
	requestPermissionsAsync: vi.fn(),
	saveToLibraryAsync: vi.fn(),
}));

vi.mock("expo-file-system/legacy", () => fileSystemMock);
vi.mock("expo-media-library", () => mediaLibraryMock);

describe("saveCapVideoToPhotos", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		fileSystemMock.downloadAsync.mockResolvedValue({
			uri: "file:///documents/Launch demo.mp4",
		});
		fileSystemMock.deleteAsync.mockResolvedValue(undefined);
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
			"file:///documents/Launch demo.mp4",
		);
		expect(mediaLibraryMock.saveToLibraryAsync).toHaveBeenCalledWith(
			"file:///documents/Launch demo.mp4",
		);
		expect(fileSystemMock.deleteAsync).toHaveBeenCalledWith(
			"file:///documents/Launch demo.mp4",
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
			"file:///documents/Launch demo.mp4",
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
});
