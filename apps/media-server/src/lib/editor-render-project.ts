import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { scanEditorProject } from "./editor-project-bundles";
import { editorWallpaperDirectory } from "./editor-wallpapers";

const MAX_RECORDING_META_BYTES = 4 * 1024 * 1024;
const MAX_RENDER_UPLOADS = 4000;
const UPLOAD_CONCURRENCY = 4;
const RENDER_SKIPPED_PATH = /^(?:output|screenshots)\//;
const WALLPAPER_FILE =
	/^(macOS|blue|purple|cities|dark|orange)\/[a-z0-9-]+\.jpg$/;

export type EditorRenderUploads = {
	files: { path: string; url: string }[];
	wallpapers: { file: string; url: string }[];
};

export async function listEditorRenderProject(projectPath: string) {
	const files = await scanEditorProject(projectPath);
	const meta = files.find((file) => file.path === "recording-meta.json");
	if (!meta || Number(meta.stats.size) > MAX_RECORDING_META_BYTES) {
		throw new Error("Editor project recording metadata is unavailable");
	}
	const recordingMeta: unknown = JSON.parse(
		await readFile(meta.source, "utf8"),
	);
	return {
		files: files
			.filter((file) => !RENDER_SKIPPED_PATH.test(file.path))
			.map((file) => ({
				path: file.path,
				size: Number(file.stats.size),
				inode: `${file.stats.dev}:${file.stats.ino}`,
			})),
		recordingMeta,
	};
}

function validUploadUrl(value: string) {
	const url = new URL(value);
	return (
		(url.protocol === "https:" ||
			(url.protocol === "http:" &&
				process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA === "1")) &&
		!url.username &&
		!url.password
	);
}

async function putFile(url: string, source: string, signal?: AbortSignal) {
	const file = Bun.file(source);
	const size = file.size;
	const response = await fetch(url, {
		method: "PUT",
		body: file,
		headers: { "Content-Length": String(size) },
		redirect: "error",
		signal,
	});
	if (!response.ok) {
		throw new Error(`Render project upload failed with ${response.status}`);
	}
	return size;
}

async function wallpaperSource(file: string) {
	if (!WALLPAPER_FILE.test(file)) throw new Error("Invalid editor wallpaper");
	const root = await realpath(editorWallpaperDirectory());
	const source = await realpath(resolve(root, file));
	const within = relative(root, source);
	if (within.startsWith("..") || isAbsolute(within) || within !== file) {
		throw new Error("Invalid editor wallpaper");
	}
	return source;
}

async function inBatches<T, R>(
	items: T[],
	run: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from(
			{ length: Math.min(UPLOAD_CONCURRENCY, items.length) },
			async () => {
				while (next < items.length) {
					const index = next++;
					results[index] = await run(items[index] as T);
				}
			},
		),
	);
	return results;
}

export async function uploadEditorRenderProject(
	projectPath: string,
	uploads: EditorRenderUploads,
	signal?: AbortSignal,
) {
	if (
		uploads.files.length + uploads.wallpapers.length > MAX_RENDER_UPLOADS ||
		new Set(uploads.files.map((upload) => upload.path)).size !==
			uploads.files.length ||
		[...uploads.files, ...uploads.wallpapers].some(
			(upload) => !validUploadUrl(upload.url),
		)
	) {
		throw new Error("Invalid render project uploads");
	}
	const files = new Map(
		(await scanEditorProject(projectPath))
			.filter((file) => !RENDER_SKIPPED_PATH.test(file.path))
			.map((file) => [file.path, file.source]),
	);
	const sources = uploads.files.map((upload) => {
		const source = files.get(upload.path);
		if (!source) throw new Error("Render project file is missing");
		return { ...upload, source };
	});
	const wallpapers = await Promise.all(
		uploads.wallpapers.map(async (upload) => ({
			...upload,
			source: await wallpaperSource(upload.file),
		})),
	);
	return {
		files: await inBatches(sources, async (upload) => ({
			path: upload.path,
			size: await putFile(upload.url, upload.source, signal),
		})),
		wallpapers: await inBatches(wallpapers, async (upload) => ({
			file: upload.file,
			size: await putFile(upload.url, upload.source, signal),
		})),
	};
}
