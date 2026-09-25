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
