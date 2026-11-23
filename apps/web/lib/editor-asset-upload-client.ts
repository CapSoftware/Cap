import {
	canonicalEditorAssetExtension,
	EDITOR_AUDIO_CONTENT_TYPES,
	EDITOR_IMAGE_CONTENT_TYPES,
	type EditorAssetKind,
	editorAssetExtension,
	validEditorAssetMeasurement,
} from "./editor-assets";

export type WebEditorImportedAsset =
	| { path: string; name: string; duration: number }
	| { path: string; name: string; width: number; height: number };

function asRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uploadTarget(value: unknown) {
	if (
		!asRecord(value) ||
		typeof value.key !== "string" ||
		typeof value.path !== "string" ||
		!asRecord(value.upload) ||
		(value.upload.type !== "put" && value.upload.type !== "driveResumable") ||
		typeof value.upload.url !== "string" ||
		!asRecord(value.upload.headers)
	) {
		return null;
	}
	const headers: Record<string, string> = {};
	for (const [name, header] of Object.entries(value.upload.headers)) {
		if (typeof header !== "string") return null;
		headers[name] = header;
	}
	let url: URL;
	try {
		url = new URL(value.upload.url);
	} catch {
		return null;
	}
	if (
		(url.protocol !== "https:" &&
			!(
				url.protocol === "http:" &&
				["localhost", "127.0.0.1"].includes(url.hostname)
			)) ||
		url.username ||
		url.password
	) {
		return null;
	}
	return {
		key: value.key,
		path: value.path,
		type: value.upload.type,
		url,
		headers,
	};
}

export async function measureEditorAsset(
	kind: EditorAssetKind,
	file: Blob,
): Promise<{ duration: number } | { width: number; height: number }> {
	if (kind === "image") {
		const bitmap = await createImageBitmap(file).catch(() => null);
		if (!bitmap) throw new Error("This image can't be read");
		const size = { width: bitmap.width, height: bitmap.height };
		bitmap.close();
		const measured = validEditorAssetMeasurement("image", size);
		if (!measured) throw new Error("This image is too large");
		return measured;
	}
	const { ALL_FORMATS, BlobSource, Input } = await import("mediabunny");
	const input = new Input({
		formats: ALL_FORMATS,
		source: new BlobSource(file),
	});
	try {
		const tracks = await input.getAudioTracks();
		if (tracks.length === 0) throw new Error("This file has no audio");
		const measured = validEditorAssetMeasurement("audio", {
			duration: await input.computeDuration(),
		});
		if (!measured) throw new Error("This audio file can't be read");
		return measured;
	} catch (error) {
		throw error instanceof Error && error.message.startsWith("This ")
			? error
			: new Error("This audio file can't be read");
	} finally {
		input.dispose();
	}
}

export async function uploadWebEditorAsset(
	videoId: string,
	kind: EditorAssetKind,
	file: File,
	signal: AbortSignal,
	fileName = file.name,
): Promise<WebEditorImportedAsset> {
	const label = kind === "audio" ? "Audio" : "Image";
	const extension = canonicalEditorAssetExtension(kind, file.name);
	const contentType =
		kind === "audio"
			? EDITOR_AUDIO_CONTENT_TYPES[extension]
			: EDITOR_IMAGE_CONTENT_TYPES[extension];
	if (
		!contentType ||
		!editorAssetExtension(kind, fileName, file.size, contentType)
	)
		throw new Error(`Unsupported ${kind} file or file is too large`);
	const measurement = await measureEditorAsset(kind, file);
	const path = `/api/editor/videos/${encodeURIComponent(videoId)}/assets`;
	const metadata = { kind, fileName, size: file.size, contentType };
	const preparation = await fetch(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(metadata),
		signal,
	});
	if (!preparation.ok) throw new Error(`${label} upload could not start`);
	const target = uploadTarget(await preparation.json());
	if (!target) throw new Error("Editor upload target was invalid");
	const headers = new Headers(target.headers);
	if (target.type === "driveResumable") {
		headers.set("Content-Range", `bytes 0-${file.size - 1}/${file.size}`);
	}
	const uploaded = await fetch(target.url, {
		method: "PUT",
		headers,
		body: file,
		credentials: "omit",
		signal,
	});
	if (!uploaded.ok) throw new Error(`${label} upload failed`);
	const completed = await fetch(path, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			...metadata,
			...measurement,
			key: target.key,
			path: target.path,
		}),
		signal,
	});
	if (!completed.ok)
		throw new Error(`${label} could not be added to the editor`);
	const imported: unknown = await completed.json();
	if (
		!asRecord(imported) ||
		imported.path !== target.path ||
		typeof imported.name !== "string"
	) {
		throw new Error(`Imported ${kind} response was invalid`);
	}
	return "duration" in measurement
		? { path: target.path, name: imported.name, ...measurement }
		: { path: target.path, name: imported.name, ...measurement };
}
