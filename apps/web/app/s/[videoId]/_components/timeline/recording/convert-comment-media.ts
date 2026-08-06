import { installAvcLevelClamp } from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/avc-level-clamp";
import { canConvertToMp4InBrowser } from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/recording-conversion";

const isMp4 = (mime: string) => mime.startsWith("video/mp4");
const isAudioMp4 = (mime: string) => mime.startsWith("audio/mp4");

const canEncodeAac = async () => {
	if (typeof AudioEncoder === "undefined") return false;
	try {
		const support = await AudioEncoder.isConfigSupported({
			codec: "mp4a.40.2",
			sampleRate: 48000,
			numberOfChannels: 2,
		});
		return support.supported === true;
	} catch {
		return false;
	}
};

const convert = async (
	blob: Blob,
	options: { video: boolean; onProgress?: (fraction: number) => void },
) => {
	const { convertMedia } = await import("@remotion/webcodecs");
	const restoreAvcLevelClamp = options.video ? installAvcLevelClamp() : null;
	try {
		const result = await convertMedia({
			src: new File([blob], "recording", { type: blob.type }),
			container: "mp4",
			...(options.video ? { videoCodec: "h264" as const } : {}),
			audioCodec: "aac",
			onProgress: ({ overallProgress }) => {
				if (overallProgress !== null)
					options.onProgress?.(Math.min(1, Math.max(0, overallProgress)));
			},
		});
		return await result.save();
	} finally {
		restoreAvcLevelClamp?.();
	}
};

/**
 * Best-effort normalization of a recorded comment to mp4 (H.264/AAC) so iOS
 * viewers can play it. Falls back to the original blob when the platform has
 * no encoder (Firefox) or conversion fails — sending must never block on
 * conversion. Returns the blob plus the true mime to persist.
 */
export async function normalizeCommentMedia(input: {
	blob: Blob;
	mime: string;
	kind: "video" | "audio";
	hasAudio: boolean;
	onProgress?: (fraction: number) => void;
}): Promise<{ blob: Blob; mime: string }> {
	const { blob, mime, kind, hasAudio, onProgress } = input;

	try {
		if (kind === "video") {
			if (isMp4(mime)) return { blob, mime: "video/mp4" };
			if (!(await canConvertToMp4InBrowser(hasAudio))) return { blob, mime };
			const converted = await convert(blob, { video: true, onProgress });
			if (converted.size === 0) return { blob, mime };
			return { blob: converted, mime: "video/mp4" };
		}

		if (isAudioMp4(mime)) return { blob, mime: "audio/mp4" };
		if (!(await canEncodeAac())) return { blob, mime };
		const converted = await convert(blob, { video: false, onProgress });
		if (converted.size === 0) return { blob, mime };
		// convertMedia's mp4 output reports video/mp4 even for audio-only input;
		// the extension/content-type allowlist wants the audio flavour.
		return {
			blob: new Blob([converted], { type: "audio/mp4" }),
			mime: "audio/mp4",
		};
	} catch {
		return { blob, mime };
	}
}
