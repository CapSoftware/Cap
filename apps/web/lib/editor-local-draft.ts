import { gunzipSync, gzipSync, strFromU8, strToU8 } from "fflate";

const MAX_DRAFT_BYTES = 8 * 1024 * 1024;
const MAX_DRAFT_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export type EditorLocalDraft = {
	config: Record<string, unknown>;
	baseSavedAt: string | null;
	capturedAt: number;
};

function draftKey(userId: string, videoId: string) {
	return `cap:web-editor-draft:${encodeURIComponent(userId)}:${encodeURIComponent(videoId)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function captureEditorLocalDraft(
	storage: Storage,
	userId: string,
	videoId: string,
	baseSavedAt: string | null,
	serialized: string,
) {
	try {
		const bytes = strToU8(serialized);
		if (bytes.byteLength > MAX_DRAFT_BYTES || !isRecord(JSON.parse(serialized)))
			return false;
		const capturedAt = Date.now();
		const key = draftKey(userId, videoId);
		try {
			storage.setItem(
				key,
				JSON.stringify({
					version: 1,
					baseSavedAt,
					capturedAt,
					config: serialized,
				}),
			);
			return true;
		} catch {
			const compressed = gzipSync(bytes, { level: 1 });
			storage.setItem(
				key,
				JSON.stringify({
					version: 2,
					baseSavedAt,
					capturedAt,
					uncompressedBytes: bytes.byteLength,
					configGzipBase64: btoa(strFromU8(compressed, true)),
				}),
			);
			return true;
		}
	} catch {
		return false;
	}
}

export function readEditorLocalDraft(
	storage: Storage,
	userId: string,
	videoId: string,
): EditorLocalDraft | null {
	try {
		const raw = storage.getItem(draftKey(userId, videoId));
		if (!raw || strToU8(raw).byteLength > MAX_DRAFT_BYTES * 2) return null;
		const value: unknown = JSON.parse(raw);
		if (
			!isRecord(value) ||
			(value.version !== 1 && value.version !== 2) ||
			(value.baseSavedAt !== null && typeof value.baseSavedAt !== "string") ||
			typeof value.capturedAt !== "number" ||
			!Number.isSafeInteger(value.capturedAt) ||
			value.capturedAt > Date.now() + 5 * 60 * 1000 ||
			Date.now() - value.capturedAt > MAX_DRAFT_AGE_MS
		) {
			return null;
		}
		let serialized: string;
		if (value.version === 1) {
			if (
				typeof value.config !== "string" ||
				strToU8(value.config).byteLength > MAX_DRAFT_BYTES
			)
				return null;
			serialized = value.config;
		} else {
			if (
				typeof value.configGzipBase64 !== "string" ||
				typeof value.uncompressedBytes !== "number" ||
				!Number.isSafeInteger(value.uncompressedBytes) ||
				value.uncompressedBytes < 2 ||
				value.uncompressedBytes > MAX_DRAFT_BYTES
			)
				return null;
			const compressed = strToU8(atob(value.configGzipBase64), true);
			if (compressed.byteLength < 18) return null;
			const gzipLength = new DataView(
				compressed.buffer,
				compressed.byteOffset + compressed.byteLength - 4,
				4,
			).getUint32(0, true);
			if (gzipLength !== value.uncompressedBytes) return null;
			serialized = strFromU8(
				gunzipSync(compressed, {
					out: new Uint8Array(value.uncompressedBytes),
				}),
			);
		}
		const config: unknown = JSON.parse(serialized);
		if (!isRecord(config)) return null;
		return {
			config,
			baseSavedAt: value.baseSavedAt,
			capturedAt: value.capturedAt,
		};
	} catch {
		return null;
	}
}

export function clearEditorLocalDraft(
	storage: Storage,
	userId: string,
	videoId: string,
) {
	try {
		storage.removeItem(draftKey(userId, videoId));
	} catch {
		return;
	}
}
