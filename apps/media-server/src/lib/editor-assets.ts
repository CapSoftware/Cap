import { runEditorFile as runFile } from "./editor-process";
import { stageSignedEditorAsset } from "./editor-signed-assets";

const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const ASSET_PATH =
	/^assets\/audio\/import-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(ogg|m4a|mp3|wav|aac|flac)$/;
const CONTENT_TYPES: Record<string, string> = {
	ogg: "audio/ogg",
	m4a: "audio/mp4",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	aac: "audio/aac",
	flac: "audio/flac",
};

export type EditorAudioAsset = {
	path: string;
	name: string;
	url: string;
	size: number;
	contentType: string;
	objectIdentity?: string | null;
};

export function validateEditorAudioAsset(asset: EditorAudioAsset) {
	const url = new URL(asset.url);
	const match = ASSET_PATH.exec(asset.path);
	if (
		!match ||
		CONTENT_TYPES[match[1] ?? ""] !== asset.contentType ||
		asset.name.length < 1 ||
		asset.name.length > 100 ||
		asset.name
			.split("")
			.some(
				(character) =>
					character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
			) ||
		!Number.isSafeInteger(asset.size) ||
		asset.size < 1 ||
		asset.size > MAX_AUDIO_BYTES ||
		(url.protocol !== "https:" &&
			!(
				url.protocol === "http:" &&
				process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA === "1"
			)) ||
		url.username ||
		url.password ||
		(asset.objectIdentity != null &&
			(asset.objectIdentity.length < 1 || asset.objectIdentity.length > 256))
	) {
		throw new Error("Invalid editor audio asset");
	}
}

async function probeAudioDuration(path: string) {
	const { stdout } = await runFile(
		"ffprobe",
		[
			"-v",
			"error",
			"-select_streams",
			"a:0",
			"-show_entries",
			"stream=codec_type:format=duration",
			"-of",
			"json",
			path,
		],
		{ timeout: 15_000, maxBuffer: 64 * 1024 },
	).catch(() => {
		throw new Error("Imported file has no audio stream");
	});
	const data: unknown = JSON.parse(stdout);
	if (
		typeof data !== "object" ||
		data === null ||
		!("streams" in data) ||
		!Array.isArray(data.streams) ||
		data.streams[0]?.codec_type !== "audio" ||
		!("format" in data) ||
		typeof data.format !== "object" ||
		data.format === null ||
		!("duration" in data.format)
	) {
		throw new Error("Imported file has no audio stream");
	}
	const duration = Number(data.format.duration);
	if (!Number.isFinite(duration) || duration <= 0 || duration > 24 * 60 * 60) {
		throw new Error("Imported audio duration is invalid");
	}
	return duration;
}

export async function stageSignedEditorAudioAsset(
	projectPath: string,
	asset: EditorAudioAsset,
	abortSignal?: AbortSignal,
) {
	validateEditorAudioAsset(asset);
	return stageSignedEditorAsset(
		projectPath,
		asset,
		async (path) => ({ duration: await probeAudioDuration(path) }),
		abortSignal,
	);
}
