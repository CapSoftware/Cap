import { initSegment, segmentHeader } from "./fmp4";
import { avcC, box, build, fullBox } from "./mp4";

export type ParsedBox = {
	type: string;
	start: number;
	size: number;
	body: Uint8Array;
};

export function parseBoxes(data: Uint8Array, start = 0, end = data.byteLength) {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const boxes: ParsedBox[] = [];
	let offset = start;
	while (offset + 8 <= end) {
		let size = view.getUint32(offset);
		const type = new TextDecoder().decode(
			data.subarray(offset + 4, offset + 8),
		);
		let header = 8;
		if (size === 1) {
			size = Number(view.getBigUint64(offset + 8));
			header = 16;
		}
		boxes.push({
			type,
			start: offset,
			size,
			body: data.subarray(offset + header, Math.min(end, offset + size)),
		});
		offset += size;
	}
	return boxes;
}

export function child(box: ParsedBox, type: string, skip = 0) {
	return parseBoxes(box.body, skip).find((entry) => entry.type === type);
}

export function u32(bytes: Uint8Array, offset: number) {
	return new DataView(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength,
	).getUint32(offset);
}

export function u64(bytes: Uint8Array, offset: number) {
	return Number(
		new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(
			offset,
		),
	);
}

// SPS (High profile) + PPS in Annex B, enough for avcC().
export const ANNEX_B_PARAMETER_SETS = Uint8Array.of(
	0,
	0,
	0,
	1,
	0x67,
	0x64,
	0x00,
	0x28,
	0xac,
	0xd9,
	0x40,
	0x78,
	0x02,
	0x27,
	0xe5,
	0x84,
	0,
	0,
	0,
	1,
	0x68,
	0xeb,
	0xe3,
	0xcb,
	0x22,
	0xc0,
);

// A complete x264 SPS (High, 4:2:0 8-bit, VUI with timing, no bitstream
// restriction) + PPS, for code that reads the SPS itself.
export const X264_PARAMETER_SETS = Uint8Array.of(
	0x00,
	0x00,
	0x00,
	0x01,
	0x67,
	0x64,
	0x00,
	0x0a,
	0xac,
	0xb2,
	0x04,
	0x17,
	0xf2,
	0xe0,
	0x22,
	0x00,
	0x00,
	0x03,
	0x00,
	0x02,
	0x00,
	0x00,
	0x03,
	0x00,
	0x78,
	0x1e,
	0x24,
	0x4c,
	0x90,
	0x00,
	0x00,
	0x00,
	0x01,
	0x68,
	0xeb,
	0xc3,
	0xcb,
	0x22,
	0xc0,
);

/**
 * A fragmented MP4 like a browser records: one fragment per GOP, video then
 * audio samples in each mdat, and optionally an mfra listing the moofs.
 * Video sample `n` is `size(n)` bytes of `n % 251 + 1`.
 */
export function fragmentedRecording(options: {
	frames: number;
	gop: number;
	audio?: boolean;
	mfra?: boolean;
}) {
	const size = (frame: number) => 50 + ((frame * 37) % 200);
	const parts: Uint8Array[] = [];
	let offset = 0;
	const push = (part: Uint8Array) => {
		parts.push(part);
		offset += part.byteLength;
	};
	push(
		initSegment({
			width: 128,
			height: 72,
			fps: 30,
			avcC: avcC(X264_PARAMETER_SETS),
			asc: options.audio ? Uint8Array.of(0x11, 0x90) : null,
		}),
	);
	const moofs: [number, number][] = [];
	for (let first = 0; first < options.frames; first += options.gop) {
		const frames = Array.from(
			{ length: Math.min(options.gop, options.frames - first) },
			(_, index) => first + index,
		);
		const audioSizes = options.audio ? frames.map(() => 9) : [];
		// segmentHeader leads with a 24-byte styp.
		moofs.push([first * 1000, offset + 24]);
		push(
			segmentHeader({
				sequence: moofs.length,
				firstFrame: first,
				videoSizes: frames.map(size),
				firstPacket: first,
				audioSizes,
			}),
		);
		for (const frame of frames) {
			push(new Uint8Array(size(frame)).fill((frame % 251) + 1));
		}
		for (const bytes of audioSizes) push(new Uint8Array(bytes).fill(0xaa));
	}
	if (options.mfra) {
		const tfra = fullBox(
			"tfra",
			1,
			0,
			build((writer) => {
				writer.u32(1);
				writer.u32(0);
				writer.u32(moofs.length);
				for (const [time, moof] of moofs) {
					writer.u64(time);
					writer.u64(moof);
					writer.u8(1);
					writer.u8(1);
					writer.u8(1);
				}
			}),
		);
		const mfroSize = 16;
		const mfraSize = 8 + tfra.byteLength + mfroSize;
		push(
			box(
				"mfra",
				tfra,
				fullBox(
					"mfro",
					0,
					0,
					build((writer) => writer.u32(mfraSize)),
				),
			),
		);
	}
	const bytes = new Uint8Array(
		parts.reduce((sum, part) => sum + part.byteLength, 0),
	);
	let at = 0;
	for (const part of parts) {
		bytes.set(part, at);
		at += part.byteLength;
	}
	return { bytes, size, moofs: moofs.map(([, moof]) => moof) };
}
