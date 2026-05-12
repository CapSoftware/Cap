import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as dialog from "@tauri-apps/plugin-dialog";
import { commands } from "~/utils/tauri";

const videoExtensions = [
	"mp4",
	"mov",
	"avi",
	"mkv",
	"webm",
	"wmv",
	"m4v",
	"flv",
];
const imageExtensions = [
	"png",
	"jpg",
	"jpeg",
	"webp",
	"gif",
	"bmp",
	"tif",
	"tiff",
];

type ImportOptions = {
	hideCurrentWindow?: boolean;
};

const selectedPath = (result: string | string[] | null) =>
	typeof result === "string" ? result : null;

const maybeHideCurrentWindow = async (options?: ImportOptions) => {
	if (options?.hideCurrentWindow) await getCurrentWindow().hide();
};

export const importVideoPath = async (
	sourcePath: string,
	options?: ImportOptions,
) => {
	const projectPath = await commands.startVideoImport(sourcePath);
	await commands.showWindow({ Editor: { project_path: projectPath } });
	await maybeHideCurrentWindow(options);
	return projectPath;
};

export const importImagePath = async (
	sourcePath: string,
	options?: ImportOptions,
) => {
	const imagePath = await invoke<string>("start_image_import", { sourcePath });
	await commands.showWindow({ ScreenshotEditor: { path: imagePath } });
	await maybeHideCurrentWindow(options);
	return imagePath;
};

export const importVideoFromPicker = async (options?: ImportOptions) => {
	const result = await dialog.open({
		filters: [
			{
				name: "Video Files",
				extensions: videoExtensions,
			},
		],
		multiple: false,
	});
	const path = selectedPath(result);
	if (!path) return null;
	return await importVideoPath(path, options);
};

export const importImageFromPicker = async (options?: ImportOptions) => {
	const result = await dialog.open({
		filters: [
			{
				name: "Image Files",
				extensions: imageExtensions,
			},
		],
		multiple: false,
	});
	const path = selectedPath(result);
	if (!path) return null;
	return await importImagePath(path, options);
};

export const showImportError = async (
	mediaType: "video" | "image",
	error: unknown,
) => {
	const message = error instanceof Error ? error.message : String(error);
	await dialog.message(`Failed to import ${mediaType}: ${message}`, {
		title: "Import Error",
		kind: "error",
	});
};
