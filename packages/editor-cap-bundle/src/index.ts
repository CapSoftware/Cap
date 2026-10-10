export const CAP_BUNDLE_CONTENT_TYPE = "application/vnd.cap.project-bundle";
export const CAP_BUNDLE_MAGIC = "CAPBND01";
export const CAP_BUNDLE_HEADER_BYTES = 12;
export const MAX_CAP_BUNDLE_BYTES = 12 * 1024 * 1024 * 1024;
export const MAX_CAP_BUNDLE_MANIFEST_BYTES = 2 * 1024 * 1024;
export const MAX_CAP_BUNDLE_FILES = 20_000;

export type CapBundleEntry = {
	path: string;
	size: number;
	offset: number;
};

export type CapBundleManifest = {
	version: 1;
	files: CapBundleEntry[];
};

export type CapBundleSource = {
	path: string;
	file: Blob;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const magicBytes = textEncoder.encode(CAP_BUNDLE_MAGIC);

export function validCapBundlePath(path: string) {
	if (
		path.length < 1 ||
		path.length > 1024 ||
		path.startsWith("/") ||
		path.includes("\\") ||
		path.includes("\0") ||
		path.split("").some((character) => character.charCodeAt(0) < 32)
	) {
		return false;
	}
	const parts = path.split("/");
	if (
		parts.some((part) => part.length === 0 || part === "." || part === "..")
	) {
		return false;
	}
	return (
		[
			"recording-meta.json",
			"project-config.json",
			"recording-diagnostics.json",
		].includes(path) ||
		(parts.length > 1 &&
			["content", "output", "screenshots"].includes(parts[0] ?? "")) ||
		(parts.length > 2 && parts[0] === "assets" && parts[1] === "audio")
	);
}

export function readCapBundleManifestLength(header: Uint8Array) {
	if (header.byteLength !== CAP_BUNDLE_HEADER_BYTES) return null;
	if (!magicBytes.every((byte, index) => header[index] === byte)) return null;
	const manifestBytes = new DataView(
		header.buffer,
		header.byteOffset,
		header.byteLength,
	).getUint32(magicBytes.length, true);
	return manifestBytes > 0 && manifestBytes <= MAX_CAP_BUNDLE_MANIFEST_BYTES
		? manifestBytes
		: null;
}

function asRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCapBundleManifest(
	manifestBytes: Uint8Array,
	bundleBytes: number,
): CapBundleManifest | null {
	if (
		manifestBytes.byteLength < 1 ||
		manifestBytes.byteLength > MAX_CAP_BUNDLE_MANIFEST_BYTES ||
		!Number.isSafeInteger(bundleBytes) ||
		bundleBytes < CAP_BUNDLE_HEADER_BYTES + manifestBytes.byteLength ||
		bundleBytes > MAX_CAP_BUNDLE_BYTES
	) {
		return null;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(textDecoder.decode(manifestBytes));
	} catch {
		return null;
	}
	if (
		!asRecord(raw) ||
		raw.version !== 1 ||
		!Array.isArray(raw.files) ||
		raw.files.length < 1 ||
		raw.files.length > MAX_CAP_BUNDLE_FILES
	) {
		return null;
	}
	const files: CapBundleEntry[] = [];
	const paths = new Set<string>();
	let offset = 0;
	for (const item of raw.files) {
		if (
			!asRecord(item) ||
			typeof item.path !== "string" ||
			!validCapBundlePath(item.path) ||
			paths.has(item.path) ||
			typeof item.size !== "number" ||
			!Number.isSafeInteger(item.size) ||
			(item.path === "recording-meta.json" ? item.size < 1 : item.size < 0) ||
			item.size > MAX_CAP_BUNDLE_BYTES ||
			item.offset !== offset
		) {
			return null;
		}
		paths.add(item.path);
		files.push({ path: item.path, size: item.size, offset });
		offset += item.size;
		if (!Number.isSafeInteger(offset) || offset > MAX_CAP_BUNDLE_BYTES) {
			return null;
		}
	}
	if (
		!paths.has("recording-meta.json") ||
		CAP_BUNDLE_HEADER_BYTES + manifestBytes.byteLength + offset !== bundleBytes
	) {
		return null;
	}
	return { version: 1, files };
}

export function createCapBundle(sources: readonly CapBundleSource[]) {
	if (sources.length < 1 || sources.length > MAX_CAP_BUNDLE_FILES) {
		throw new Error("Cap project has too many files");
	}
	const sorted = [...sources].sort((a, b) => a.path.localeCompare(b.path));
	const files: CapBundleEntry[] = [];
	const paths = new Set<string>();
	let offset = 0;
	for (const source of sorted) {
		if (
			!validCapBundlePath(source.path) ||
			paths.has(source.path) ||
			!(source.file instanceof Blob) ||
			!Number.isSafeInteger(source.file.size) ||
			(source.path === "recording-meta.json"
				? source.file.size < 1
				: source.file.size < 0)
		) {
			throw new Error("Cap project contains an invalid file");
		}
		paths.add(source.path);
		files.push({ path: source.path, size: source.file.size, offset });
		offset += source.file.size;
		if (!Number.isSafeInteger(offset) || offset > MAX_CAP_BUNDLE_BYTES) {
			throw new Error("Cap project is too large to import");
		}
	}
	if (!paths.has("recording-meta.json")) {
		throw new Error("Cap project is missing recording metadata");
	}
	const manifestBytes = textEncoder.encode(
		JSON.stringify({ version: 1, files } satisfies CapBundleManifest),
	);
	if (
		manifestBytes.byteLength > MAX_CAP_BUNDLE_MANIFEST_BYTES ||
		CAP_BUNDLE_HEADER_BYTES + manifestBytes.byteLength + offset >
			MAX_CAP_BUNDLE_BYTES
	) {
		throw new Error("Cap project bundle is too large to import");
	}
	const header = new Uint8Array(CAP_BUNDLE_HEADER_BYTES);
	header.set(magicBytes);
	new DataView(header.buffer).setUint32(
		magicBytes.length,
		manifestBytes.length,
		true,
	);
	return new Blob(
		[header, manifestBytes, ...sorted.map((source) => source.file)],
		{ type: CAP_BUNDLE_CONTENT_TYPE },
	);
}
