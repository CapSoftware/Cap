import { gunzipSync, gzipSync } from "node:zlib";
import type { VideoMetadata } from "@cap/database/types";

export const MAX_WEB_EDITOR_CONFIG_BYTES = 8 * 1024 * 1024;

type SavedProject = NonNullable<VideoMetadata["webEditorProject"]>;

function isConfig(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function encodeWebEditorProject(config: Record<string, unknown>) {
	const serialized = JSON.stringify(config);
	const raw = Buffer.from(serialized, "utf8");
	if (raw.length > MAX_WEB_EDITOR_CONFIG_BYTES) {
		throw new Error("Editor project configuration is too large");
	}
	const compressed = gzipSync(raw, { level: 1 });
	const project: SavedProject = {
		version: 2,
		configGzipBase64: compressed.toString("base64"),
		uncompressedBytes: raw.length,
		savedAt: new Date().toISOString(),
	};
	return { project, serialized };
}

export function decodeWebEditorProject(
	project: SavedProject,
): Record<string, unknown> | null {
	if (project.version === 1) {
		if (!isConfig(project.config)) return null;
		return Buffer.byteLength(JSON.stringify(project.config), "utf8") <=
			MAX_WEB_EDITOR_CONFIG_BYTES
			? project.config
			: null;
	}
	if (
		!Number.isSafeInteger(project.uncompressedBytes) ||
		project.uncompressedBytes < 2 ||
		project.uncompressedBytes > MAX_WEB_EDITOR_CONFIG_BYTES ||
		project.configGzipBase64.length >
			Math.ceil((MAX_WEB_EDITOR_CONFIG_BYTES * 4) / 3) + 4 ||
		project.configGzipBase64.length % 4 !== 0 ||
		!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
			project.configGzipBase64,
		)
	) {
		return null;
	}
	try {
		const compressed = Buffer.from(project.configGzipBase64, "base64");
		const raw = gunzipSync(compressed, {
			maxOutputLength: MAX_WEB_EDITOR_CONFIG_BYTES,
		});
		if (raw.length !== project.uncompressedBytes) return null;
		const value: unknown = JSON.parse(raw.toString("utf8"));
		return isConfig(value) ? value : null;
	} catch {
		return null;
	}
}
