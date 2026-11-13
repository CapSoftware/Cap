import { open } from "node:fs/promises";
import { spawnSync } from "bun";

export const INPUT_POLICY_VIOLATION = "input-policy-violation";

const REJECTED_PREFIX = "Media input rejected:";

export class MediaInputPolicyError extends Error {
	readonly code = INPUT_POLICY_VIOLATION;

	constructor(reason: string) {
		super(`${REJECTED_PREFIX} ${reason}`);
		this.name = "MediaInputPolicyError";
	}
}

// Decode memory grows with the pixel count, so that is what is capped: 8K in
// either orientation, up to the DCI width. No H.264 level describes a side
// longer than 16384.
export const MAX_SOURCE_FRAME_PIXELS = 8192 * 4320;
export const MAX_SOURCE_FRAME_SIDE = 16384;
// A container can declare a smaller frame than its video stream carries, so
// FFmpeg is held to the limit too. Decoders pad a frame to whole blocks and
// aligned rows, which is the room above the probe's cap.
export const MAX_DECODE_PIXELS = 40_000_000;

export function exceedsSourceFrameLimit(width: number, height: number) {
	return (
		width > MAX_SOURCE_FRAME_SIDE ||
		height > MAX_SOURCE_FRAME_SIDE ||
		width * height > MAX_SOURCE_FRAME_PIXELS
	);
}

// Demuxers that open further files or network resources named inside the input.
export const NESTED_RESOURCE_DEMUXERS = [
	"hls",
	"dash",
	"concat",
	"imf",
	"sdp",
	"rtsp",
	"rtp",
	"sap",
	"mlv",
	"vobsub",
] as const;

const NESTED_RESOURCE_DEMUXER_SET = new Set<string>(NESTED_RESOURCE_DEMUXERS);

// The containers this server reads. FFmpeg ships hundreds more, and a new
// release can add one that opens other resources, so the list is fixed and a
// build can only narrow it.
export const ALLOWED_DEMUXERS = [
	"mov,mp4,m4a,3gp,3g2,mj2",
	"matroska,webm",
	"mpegts",
	"avi",
	"flv",
	"ogg",
	"wav",
	"w64",
	"mp3",
	"aac",
	"flac",
	"caf",
	"aiff",
	"asf",
	"mpeg",
	"h264",
	"hevc",
	"gif",
	"image2",
	"png_pipe",
	"jpeg_pipe",
	"webp_pipe",
] as const;

export function parseSafeDemuxers(listing: string): string[] {
	const names: string[] = [];
	for (const line of listing.split("\n")) {
		const match = /^ ([D ])([E ])([d ]) +([a-z0-9_]+(?:,[a-z0-9_]+)*)\s/i.exec(
			line,
		);
		if (!match || match[1] !== "D" || match[3] === "d") continue;
		const name = match[4] as string;
		if (name.split(",").some((alias) => NESTED_RESOURCE_DEMUXER_SET.has(alias)))
			continue;
		names.push(name);
	}
	return names;
}

// The allowed demuxers the build has. A listing that cannot be read leaves
// the fixed list as it is: FFmpeg ignores a name it does not know.
export function allowedDemuxersIn(listing: string): string[] {
	const reported = new Set(
		parseSafeDemuxers(listing).flatMap((name) => name.split(",")),
	);
	if (reported.size === 0) return [...ALLOWED_DEMUXERS];
	const present = ALLOWED_DEMUXERS.filter((name) =>
		name.split(",").some((alias) => reported.has(alias)),
	);
	return present.length > 0 ? present : [...ALLOWED_DEMUXERS];
}

let safeDemuxerWhitelist: string | undefined;

export function getSafeDemuxerWhitelist(): string {
	if (safeDemuxerWhitelist !== undefined) return safeDemuxerWhitelist;
	let listing = "";
	try {
		const result = spawnSync(["ffmpeg", "-hide_banner", "-demuxers"], {
			stdout: "pipe",
			stderr: "ignore",
			stdin: "ignore",
			env: { PATH: process.env.PATH ?? "" },
		});
		if (result.exitCode === 0) listing = result.stdout.toString();
	} catch {}
	safeDemuxerWhitelist = allowedDemuxersIn(listing).join(",");
	return safeDemuxerWhitelist;
}

// Older video formats a regular Cap import can still carry: DVD and broadcast
// MPEG, Windows Media, Flash, early MPEG-4 and Ogg video. FFmpeg's decoders
// for them are mature. Named as ffprobe names the codec.
const LEGACY_VIDEO_CODECS = [
	"mpeg1video",
	"mpeg2video",
	"wmv1",
	"wmv2",
	"wmv3",
	"vc1",
	"msmpeg4v1",
	"msmpeg4v2",
	"msmpeg4v3",
	"flv1",
	"h263",
	"h263i",
	"h263p",
	"theora",
];

// Decoders for those formats whose name differs from the codec name.
const LEGACY_VIDEO_DECODERS = ["msmpeg4", "flv"];

// Audio in those older files: MPEG audio layer 2, Windows Media audio, AMR
// from phones, and ADPCM in AVI and WAV.
const LEGACY_AUDIO_DECODERS = [
	"mp2",
	"mp2float",
	"wmav1",
	"wmav2",
	"amrnb",
	"amrwb",
	"libopencore_amrnb",
	"libopencore_amrwb",
	"adpcm_ima_wav",
	"adpcm_ms",
];

// Video codecs this server accepts in an upload, as ffprobe names them.
export const ALLOWED_VIDEO_CODECS: readonly string[] = [
	"h264",
	"hevc",
	"vp8",
	"vp9",
	"av1",
	"prores",
	"mpeg4",
	"mjpeg",
	...LEGACY_VIDEO_CODECS,
];

export function isAllowedVideoCodec(codec: string): boolean {
	return ALLOWED_VIDEO_CODECS.includes(codec.toLowerCase());
}

const PCM_DECODERS = [
	"pcm_alaw",
	"pcm_bluray",
	"pcm_dvd",
	"pcm_f16le",
	"pcm_f24le",
	"pcm_f32be",
	"pcm_f32le",
	"pcm_f64be",
	"pcm_f64le",
	"pcm_mulaw",
	"pcm_s16be",
	"pcm_s16be_planar",
	"pcm_s16le",
	"pcm_s16le_planar",
	"pcm_s24be",
	"pcm_s24le",
	"pcm_s24le_planar",
	"pcm_s32be",
	"pcm_s32le",
	"pcm_s32le_planar",
	"pcm_s64be",
	"pcm_s64le",
	"pcm_s8",
	"pcm_s8_planar",
	"pcm_u16be",
	"pcm_u16le",
	"pcm_u24be",
	"pcm_u24le",
	"pcm_u32be",
	"pcm_u32le",
	"pcm_u8",
];

// Every decoder FFmpeg may open for an input, by decoder name, which is what
// FFmpeg matches. The accepted video codecs with the library and GPU
// decoders that read them, the audio a recording or an import carries (DTS
// included, so a file with it keeps its audio), and the subtitles and cover
// art some uploads carry: FFmpeg copies a text subtitle into an MP4 by
// default, and ffprobe stops on any stream whose decoder it may not open.
export const ALLOWED_DECODERS: readonly string[] = [
	...ALLOWED_VIDEO_CODECS,
	"libdav1d",
	"libaom-av1",
	"libvpx",
	"libvpx-vp9",
	"h264_cuvid",
	"hevc_cuvid",
	"vp8_cuvid",
	"vp9_cuvid",
	"av1_cuvid",
	"mjpeg_cuvid",
	"mpeg4_cuvid",
	"aac",
	"aac_fixed",
	"aac_latm",
	"mp3",
	"mp3float",
	"opus",
	"libopus",
	"vorbis",
	"libvorbis",
	"flac",
	"alac",
	"ac3",
	"ac3_fixed",
	"eac3",
	"dca",
	...LEGACY_VIDEO_DECODERS,
	...LEGACY_AUDIO_DECODERS,
	...PCM_DECODERS,
	"mov_text",
	"subrip",
	"srt",
	"ass",
	"ssa",
	"webvtt",
	"text",
	"png",
	"bmp",
	"gif",
	"webp",
];

export const DECODER_WHITELIST = ALLOWED_DECODERS.join(",");

export const UNSUPPORTED_FORMAT_MESSAGE =
	"This video format is not supported. Upload H.264, HEVC, VP8, VP9, AV1, ProRes, MPEG-4 or Motion JPEG video.";

const MAX_TRUSTED_PLAYLISTS = 1000;
const trustedPlaylists = new Set<string>();

// Playlists this server wrote itself after fetching them from a trusted streaming host.
export function trustLocalPlaylist(path: string): void {
	trustedPlaylists.delete(path);
	trustedPlaylists.add(path);
	if (trustedPlaylists.size > MAX_TRUSTED_PLAYLISTS) {
		const oldest = trustedPlaylists.values().next().value;
		if (oldest !== undefined) trustedPlaylists.delete(oldest);
	}
}

export function isTrustedLocalPlaylist(path: string): boolean {
	return trustedPlaylists.has(path);
}

export function parseTrustedStreamingHosts(
	value: string | undefined,
): string[] {
	const hosts = (value ?? "loom.com")
		.split(",")
		.map((host) => host.trim().toLowerCase())
		.filter(Boolean);
	return hosts.length > 0 ? hosts : ["loom.com"];
}

export function isTrustedStreamingUrl(
	value: string,
	trustedHosts: readonly string[],
): boolean {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	const host = url.hostname.toLowerCase();
	if (url.username || url.password) return false;
	if (url.protocol === "https:")
		return trustedHosts.some(
			(trusted) => host === trusted || host.endsWith(`.${trusted}`),
		);
	return url.protocol === "http:" && trustedHosts.includes(host);
}

export function assertTrustedStreamingUrl(
	value: string,
	trustedHosts: readonly string[] = parseTrustedStreamingHosts(
		process.env.MEDIA_SERVER_STREAMING_HOSTS,
	),
): void {
	if (!isTrustedStreamingUrl(value, trustedHosts))
		throw new MediaInputPolicyError(
			"streaming playlists are only accepted from trusted hosts",
		);
}

const TEXT_CONTAINER_SIGNATURES = [
	/^#EXTM3U/i,
	/^#EXT-X-/i,
	/^#EXTINF/i,
	/^ffconcat\s+version/i,
	/^(?:concat|file|data|subfile|crypto|https?|rtmp|rtsp|ftp):/i,
	/^<MPD[\s>]/i,
	/^<\?xml[\s\S]*<(?:MPD|CompositionPlaylist|SmoothStreamingMedia)[\s>]/i,
	/^v=0\s*\r?\n(?:o|s)=/,
];

export function looksLikeTextContainer(head: Uint8Array): boolean {
	let text = new TextDecoder("utf-8", { fatal: false }).decode(head);
	if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
	text = text.trimStart();
	return TEXT_CONTAINER_SIGNATURES.some((signature) => signature.test(text));
}

const SNIFF_BYTES = 4096;

export async function assertMediaFileContent(path: string): Promise<void> {
	const handle = await open(path, "r");
	try {
		const head = new Uint8Array(SNIFF_BYTES);
		const { bytesRead } = await handle.read(head, 0, SNIFF_BYTES, 0);
		if (looksLikeTextContainer(head.subarray(0, bytesRead)))
			throw new MediaInputPolicyError(
				"the file is a playlist or resource list, not a media file",
			);
	} finally {
		await handle.close();
	}
}

const NESTED_DEMUXER_REJECTED = new RegExp(
	`\\[(?:${NESTED_RESOURCE_DEMUXERS.join("|")}) @ [^\\]]*\\] Format not on whitelist`,
);
const PROTOCOL_REJECTED = /Protocol '[^']+' not on whitelist/;
const DECODER_REJECTED = /Codec \([^)]*\) not on whitelist/;

export function isDecoderRejectedMessage(message: string | undefined) {
	return Boolean(message) && DECODER_REJECTED.test(message as string);
}

export function isInputPolicyViolationMessage(message: string | undefined) {
	if (!message) return false;
	return (
		message.includes(REJECTED_PREFIX) ||
		NESTED_DEMUXER_REJECTED.test(message) ||
		PROTOCOL_REJECTED.test(message)
	);
}

const MEDIA_EXTENSIONS = new Set([
	".mp4",
	".m4v",
	".mov",
	".webm",
	".mkv",
	".avi",
	".flv",
	".ts",
	".mts",
	".m2ts",
	".mpg",
	".mpeg",
	".wmv",
	".3gp",
	".ogv",
	".ogg",
	".mp3",
	".m4a",
	".aac",
	".wav",
	".flac",
	".opus",
	".caf",
	".aiff",
]);

export function isMediaFileExtension(extension: string): boolean {
	return MEDIA_EXTENSIONS.has(extension.toLowerCase());
}
