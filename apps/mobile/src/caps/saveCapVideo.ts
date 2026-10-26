import * as FileSystem from "expo-file-system/legacy";
import * as MediaLibrary from "expo-media-library";
import type { MobileApiClient } from "@/api/mobile";

export class PhotosPermissionDeniedError extends Error {
	constructor() {
		super("Photos access needed");
		this.name = "PhotosPermissionDeniedError";
	}
}

const safeFileName = (fileName: string) => {
	const name = fileName.replace(/[^\w.\- ]+/g, "").trim();
	return !name || name === "." || name === ".." ? "Cap.mp4" : name;
};

let downloadSequence = 0;

export const saveCapVideoToPhotos = async (
	client: MobileApiClient,
	capId: string,
) => {
	const permission = await MediaLibrary.requestPermissionsAsync();
	if (!permission.granted) throw new PhotosPermissionDeniedError();

	const download = await client.getDownload(capId);
	const directory = FileSystem.cacheDirectory ?? FileSystem.documentDirectory;
	if (!directory) throw new Error("Temporary download storage is unavailable");
	const temporaryDirectory = `${directory}cap-download-${Date.now()}-${downloadSequence++}/`;
	const target = `${temporaryDirectory}${safeFileName(download.fileName)}`;
	try {
		await FileSystem.makeDirectoryAsync(temporaryDirectory, {
			intermediates: true,
		});
		const result = await FileSystem.downloadAsync(download.url, target);
		if (result.status < 200 || result.status >= 300) {
			throw new Error(`Video download failed: HTTP ${result.status}`);
		}
		await MediaLibrary.saveToLibraryAsync(result.uri);
	} finally {
		await FileSystem.deleteAsync(temporaryDirectory, {
			idempotent: true,
		}).catch(() => {});
	}

	return download.fileName;
};
