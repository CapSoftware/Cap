import {
	avc1,
	box,
	build,
	dinf,
	fullBox,
	hdlr,
	MATRIX,
	mdhd,
	mp4a,
	tkhd,
} from "./mp4";

// Fragmented MP4 for HLS: one init segment per export, then self-contained
// media segments (moof + mdat) that chunk workers upload while they render.
// Timescales match the flat MP4 (video fps*1000 with 1000 per frame, audio
// 48 kHz with 1024 per AAC packet), so both outputs carry identical samples.

export const VIDEO_TRACK = 1;
export const AUDIO_TRACK = 2;
const PRIMING = 1024;

function emptyStbl(stsd: Uint8Array) {
	const empty = (type: string) =>
		fullBox(
			type,
			0,
			0,
			build((writer) => writer.u32(0)),
		);
	return box(
		"stbl",
		fullBox(
			"stsd",
			0,
			0,
			build((writer) => writer.u32(1)),
			stsd,
		),
		empty("stts"),
		empty("stsc"),
		fullBox(
			"stsz",
			0,
			0,
			build((writer) => {
				writer.u32(0);
				writer.u32(0);
			}),
		),
		empty("stco"),
	);
}

export function initSegment(input: {
	width: number;
	height: number;
	fps: number;
	avcC: Uint8Array;
	asc: Uint8Array | null;
}) {
	const ftyp = box(
		"ftyp",
		build((writer) => {
			writer.ascii("iso6");
			writer.u32(0);
			writer.ascii("iso6isomavc1mp41dash");
		}),
	);
	const mvhd = fullBox(
		"mvhd",
		0,
		0,
		build((writer) => {
			writer.u32(0);
			writer.u32(0);
			writer.u32(1000);
			writer.u32(0);
			writer.u32(0x10000);
			writer.u16(0x100);
			writer.zeros(10);
			for (const value of MATRIX) writer.u32(value);
			writer.zeros(24);
			writer.u32(input.asc ? 3 : 2);
		}),
	);
	const tracks = [
		box(
			"trak",
			tkhd(VIDEO_TRACK, 0, false, input.width, input.height),
			box(
				"mdia",
				mdhd(input.fps * 1000, 0),
				hdlr("vide", "VideoHandler"),
				box(
					"minf",
					fullBox("vmhd", 0, 1, new Uint8Array(8)),
					dinf(),
					emptyStbl(avc1(input.width, input.height, input.avcC)),
				),
			),
		),
	];
	const trex = (track: number) =>
		fullBox(
			"trex",
			0,
			0,
			build((writer) => {
				writer.u32(track);
				writer.u32(1);
				writer.u32(0);
				writer.u32(0);
				writer.u32(0);
			}),
		);
	const trexes = [trex(VIDEO_TRACK)];
	if (input.asc) {
		// Same priming skip as the flat file; duration 0 = "the whole track".
		const edts = box(
			"edts",
			fullBox(
				"elst",
				0,
				0,
				build((writer) => {
					writer.u32(1);
					writer.u32(0);
					writer.u32(PRIMING);
					writer.u16(1);
					writer.u16(0);
				}),
			),
		);
		tracks.push(
			box(
				"trak",
				tkhd(AUDIO_TRACK, 0, true, 0, 0),
				edts,
				box(
					"mdia",
					mdhd(48000, 0),
					hdlr("soun", "SoundHandler"),
					box(
						"minf",
						fullBox("smhd", 0, 0, new Uint8Array(4)),
						dinf(),
						emptyStbl(mp4a(input.asc)),
					),
				),
			),
		);
		trexes.push(trex(AUDIO_TRACK));
	}
	const moov = box("moov", mvhd, ...tracks, box("mvex", ...trexes));
	const out = new Uint8Array(ftyp.byteLength + moov.byteLength);
	out.set(ftyp, 0);
	out.set(moov, ftyp.byteLength);
	return out;
}

/**
 * styp + moof + mdat header for one segment; the caller appends the video
 * sample bytes, then the audio packet bytes. `firstFrame` and `firstPacket`
 * are global indices (the decode timeline of the whole export).
 */
export function segmentHeader(input: {
	sequence: number;
	firstFrame: number;
	videoSizes: number[];
	firstPacket: number;
	audioSizes: number[];
}) {
	const videoBytes = input.videoSizes.reduce((sum, size) => sum + size, 0);
	const audioBytes = input.audioSizes.reduce((sum, size) => sum + size, 0);
	const styp = box(
		"styp",
		build((writer) => {
			writer.ascii("msdh");
			writer.u32(0);
			writer.ascii("msdhmsix");
		}),
	);
	const tfhd = (track: number) =>
		// default-base-is-moof: data offsets count from the moof's first byte.
		fullBox(
			"tfhd",
			0,
			0x020000,
			build((writer) => writer.u32(track)),
		);
	const tfdt = (time: number) =>
		fullBox(
			"tfdt",
			1,
			0,
			build((writer) => writer.u64(time)),
		);
	const make = (moofSize: number) => {
		const videoTrun = fullBox(
			"trun",
			0,
			0x000001 | 0x000100 | 0x000200 | 0x000400,
			build((writer) => {
				writer.u32(input.videoSizes.length);
				writer.u32(moofSize + 8);
				input.videoSizes.forEach((size, index) => {
					writer.u32(1000);
					writer.u32(size);
					// Segments always open on an IDR; B-frames are off.
					writer.u32(index === 0 ? 0x02000000 : 0x01010000);
				});
			}),
		);
		const trafs = [
			box("traf", tfhd(VIDEO_TRACK), tfdt(input.firstFrame * 1000), videoTrun),
		];
		if (input.audioSizes.length > 0) {
			const audioTrun = fullBox(
				"trun",
				0,
				0x000001 | 0x000100 | 0x000200,
				build((writer) => {
					writer.u32(input.audioSizes.length);
					writer.u32(moofSize + 8 + videoBytes);
					for (const size of input.audioSizes) {
						writer.u32(1024);
						writer.u32(size);
					}
				}),
			);
			trafs.push(
				box(
					"traf",
					tfhd(AUDIO_TRACK),
					tfdt(input.firstPacket * 1024),
					audioTrun,
				),
			);
		}
		return box(
			"moof",
			fullBox(
				"mfhd",
				0,
				0,
				build((writer) => writer.u32(input.sequence)),
			),
			...trafs,
		);
	};
	// trun data offsets are fixed width, so the moof size is known up front.
	const moof = make(make(0).byteLength);
	const mdat = build((writer) => {
		writer.u32(8 + videoBytes + audioBytes);
		writer.ascii("mdat");
	});
	const out = new Uint8Array(
		styp.byteLength + moof.byteLength + mdat.byteLength,
	);
	out.set(styp, 0);
	out.set(moof, styp.byteLength);
	out.set(mdat, styp.byteLength + moof.byteLength);
	return out;
}

export function playlist(
	segments: { url: string; duration: number }[],
	options: { initUrl: string; targetDuration: number; ended: boolean },
) {
	const lines = [
		"#EXTM3U",
		"#EXT-X-VERSION:7",
		`#EXT-X-TARGETDURATION:${options.targetDuration}`,
		"#EXT-X-MEDIA-SEQUENCE:0",
		"#EXT-X-PLAYLIST-TYPE:EVENT",
		"#EXT-X-INDEPENDENT-SEGMENTS",
		`#EXT-X-MAP:URI="${options.initUrl}"`,
	];
	for (const segment of segments) {
		lines.push(`#EXTINF:${segment.duration.toFixed(3)},`, segment.url);
	}
	if (options.ended) lines.push("#EXT-X-ENDLIST");
	return `${lines.join("\n")}\n`;
}
