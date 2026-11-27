import {
	registerEditorImportedImage,
	resolveEditorImportedImage,
} from "./editor-file-mapping";

const DATABASE_NAME = "cap-web-editor-presets";
const STORE_NAME = "presets";
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const IMAGE_PATH =
	/^content\/images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|gif|bmp|tiff)$/;
const LOCAL_IMAGE_PATH =
	/^cap-web-editor:\/\/app-data\/[^/\\]{1,300}\.(png|jpg|jpeg|webp|gif|bmp|tif|tiff)$/i;
const CONTENT_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
	bmp: "image/bmp",
	tiff: "image/tiff",
};

type SavedImage = {
	bytes: Uint8Array;
	contentType: string;
	videoId: string;
};
type SavedPresets = {
	key: string;
	value: unknown | null;
	images: Record<string, SavedImage>;
};
type AssetContext = { base: URL; videoId: string };

let assetContext: AssetContext | null = null;

function asRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function presetKey(scope: string, path: string) {
	return `${scope}:${path}`;
}

function sourceImagePath(value: unknown) {
	if (!asRecord(value) || !asRecord(value.background)) return null;
	const source = value.background.source;
	if (!asRecord(source) || source.type !== "image") return null;
	if (
		typeof source.path !== "string" ||
		source.path.split("").some((character) => {
			const code = character.charCodeAt(0);
			return code < 32 || code === 127;
		}) ||
		(!IMAGE_PATH.test(source.path) && !LOCAL_IMAGE_PATH.test(source.path))
	) {
		throw new Error("Preset background image path is invalid");
	}
	return source.path;
}

function presetImagePaths(value: unknown) {
	if (!asRecord(value) || !Array.isArray(value.presets)) {
		throw new Error("Editor presets are invalid");
	}
	const paths = new Set<string>();
	for (const preset of value.presets) {
		if (!asRecord(preset)) throw new Error("Editor preset is invalid");
		const path = sourceImagePath(preset.config);
		if (path) paths.add(path);
	}
	return [...paths];
}

function imageContentType(path: string) {
	const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
	return (
		CONTENT_TYPES[
			extension === "jpeg" ? "jpg" : extension === "tif" ? "tiff" : extension
		] ?? null
	);
}

function validSavedImage(value: unknown): value is SavedImage {
	return (
		asRecord(value) &&
		value.bytes instanceof Uint8Array &&
		value.bytes.byteLength > 0 &&
		value.bytes.byteLength <= MAX_IMAGE_BYTES &&
		typeof value.contentType === "string" &&
		typeof value.videoId === "string" &&
		value.videoId.length > 0
	);
}

function openDatabase() {
	return new Promise<IDBDatabase>((resolve, reject) => {
		if (typeof indexedDB === "undefined") {
			reject(new Error("Browser storage is unavailable for editor presets"));
			return;
		}
		const request = indexedDB.open(DATABASE_NAME, 1);
		const timeout = window.setTimeout(() => {
			reject(
				new Error("Browser storage timed out while opening editor presets"),
			);
		}, 15_000);
		request.onupgradeneeded = () => {
			if (!request.result.objectStoreNames.contains(STORE_NAME)) {
				request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
			}
		};
		request.onsuccess = () => {
			window.clearTimeout(timeout);
			request.result.onversionchange = () => request.result.close();
			resolve(request.result);
		};
		request.onerror = () => {
			window.clearTimeout(timeout);
			reject(
				request.error ?? new Error("Could not open editor preset storage"),
			);
		};
		request.onblocked = () => {
			window.clearTimeout(timeout);
			reject(new Error("Editor preset storage is blocked by another tab"));
		};
	});
}

async function readRecord(key: string): Promise<SavedPresets | null> {
	const database = await openDatabase();
	try {
		return await new Promise<SavedPresets | null>((resolve, reject) => {
			const transaction = database.transaction(STORE_NAME, "readonly");
			const request = transaction.objectStore(STORE_NAME).get(key);
			let result: unknown = null;
			request.onsuccess = () => {
				result = request.result ?? null;
			};
			transaction.oncomplete = () =>
				resolve(
					asRecord(result) && result.key === key
						? (result as SavedPresets)
						: null,
				);
			transaction.onerror = () =>
				reject(transaction.error ?? new Error("Could not read editor presets"));
			transaction.onabort = () =>
				reject(transaction.error ?? new Error("Could not read editor presets"));
		});
	} finally {
		database.close();
	}
}

async function writeRecord(record: SavedPresets) {
	const database = await openDatabase();
	try {
		await new Promise<void>((resolve, reject) => {
			const transaction = database.transaction(STORE_NAME, "readwrite");
			transaction.objectStore(STORE_NAME).put(record);
			transaction.oncomplete = () => resolve();
			transaction.onerror = () =>
				reject(transaction.error ?? new Error("Could not save editor presets"));
			transaction.onabort = () =>
				reject(transaction.error ?? new Error("Could not save editor presets"));
		});
	} finally {
		database.close();
	}
}

async function loadImage(path: string) {
	const context = assetContext;
	if (!context) throw new Error("Editor preset background is unavailable");
	const mapped = resolveEditorImportedImage(path);
	if (!IMAGE_PATH.test(mapped)) {
		throw new Error("Editor preset background is unavailable");
	}
	const contentType = imageContentType(mapped);
	if (!contentType) throw new Error("Editor preset background is unsupported");
	const url = new URL(context.base);
	url.searchParams.set("path", mapped);
	url.searchParams.set("raw", "1");
	const response = await fetch(url, {
		credentials: "same-origin",
		cache: "no-store",
	});
	if (!response.ok || response.headers.get("Content-Type") !== contentType) {
		throw new Error("Editor preset background could not be saved");
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength < 1 || bytes.byteLength > MAX_IMAGE_BYTES) {
		throw new Error("Editor preset background is too large");
	}
	return { bytes, contentType, videoId: context.videoId };
}

export function setEditorPresetAssetBase(value: string) {
	assetContext = null;
	if (
		typeof window === "undefined" ||
		!value.startsWith("/") ||
		value.startsWith("//")
	)
		return;
	let base: URL;
	try {
		base = new URL(value, window.location.origin);
	} catch {
		return;
	}
	const videoId = base.searchParams.get("videoId");
	if (
		base.origin !== window.location.origin ||
		!/^\/api\/editor\/sessions\/[^/]{1,100}\/file$/.test(base.pathname) ||
		!videoId ||
		videoId.length > 100
	) {
		return;
	}
	assetContext = { base, videoId };
}

export async function loadEditorPresets(scope: string, path: string) {
	const record = await readRecord(presetKey(scope, path));
	return record
		? { found: true, value: record.value ?? undefined }
		: { found: false, value: undefined };
}

export async function saveEditorPresets(
	scope: string,
	path: string,
	value: unknown,
) {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) throw new Error("Editor presets are invalid");
	const storedValue: unknown = JSON.parse(serialized);
	const key = presetKey(scope, path);
	const previous = await readRecord(key);
	const images: Record<string, SavedImage> = {};
	for (const imagePath of presetImagePaths(storedValue)) {
		const saved = previous?.images?.[imagePath];
		images[imagePath] = validSavedImage(saved)
			? saved
			: await loadImage(imagePath);
	}
	await writeRecord({ key, value: storedValue, images });
}

export async function deleteEditorPresets(scope: string, path: string) {
	await writeRecord({ key: presetKey(scope, path), value: null, images: {} });
}

export async function prepareEditorPresetBackground(
	scope: string,
	path: string,
	config: unknown,
	importImage: (file: File) => Promise<{ path: string }>,
) {
	const imagePath = sourceImagePath(config);
	if (!imagePath) return;
	const mapped = resolveEditorImportedImage(imagePath);
	if (mapped !== imagePath) return;
	const record = await readRecord(presetKey(scope, path));
	const saved = record?.images?.[imagePath];
	if (!validSavedImage(saved)) {
		throw new Error("This preset background is no longer available");
	}
	if (saved.videoId === assetContext?.videoId && IMAGE_PATH.test(imagePath))
		return;
	const contentType = imageContentType(imagePath);
	if (!contentType || saved.contentType !== contentType) {
		throw new Error("This preset background is unsupported");
	}
	if (!(saved.bytes.buffer instanceof ArrayBuffer)) {
		throw new Error("This preset background is unavailable");
	}
	const extension = imagePath.split(".").at(-1)?.toLowerCase() ?? "";
	const file = new File(
		[
			saved.bytes.buffer.slice(
				saved.bytes.byteOffset,
				saved.bytes.byteOffset + saved.bytes.byteLength,
			),
		],
		`preset-background.${extension}`,
		{
			type: contentType,
		},
	);
	const imported = await importImage(file);
	registerEditorImportedImage(imagePath, imported.path);
}
