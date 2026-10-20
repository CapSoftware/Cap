import * as FileSystem from "expo-file-system/legacy";
import * as MediaLibrary from "expo-media-library";
import type { MobileApiClient } from "@/api/mobile";

export class PhotosPermissionDeniedError extends Error {
	constructor() {
		super("Photos access needed");
		this.name = "PhotosPermissionDeniedError";
	}
}

const safeFileName = (fileName: string) =>
	fileName.replace(/[^\w.\- ]+/g, "").trim() || "Cap.mp4";

export const saveCapVideoToPhotos = async (
	client: MobileApiClient,
	capId: string,
) => {
	const permission = await MediaLibrary.requestPermissionsAsync();
	if (!permission.granted) throw new PhotosPermissionDeniedError();

	const download = await client.getDownload(capId);
	const target = `${FileSystem.documentDirectory}${safeFileName(
		download.fileName,
	)}`;
	const result = await FileSystem.downloadAsync(download.url, target);
	try {
		await MediaLibrary.saveToLibraryAsync(result.uri);
	} finally {
		await FileSystem.deleteAsync(result.uri, { idempotent: true });
	}

	return download.fileName;
};
