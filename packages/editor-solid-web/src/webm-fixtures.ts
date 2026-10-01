const UNKNOWN = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

function id(value: number) {
	const bytes: number[] = [];
	for (let rest = value; rest > 0; rest = Math.floor(rest / 256)) {
		bytes.unshift(rest & 0xff);
	}
	return bytes;
}

function size(length: number) {
	if (length < 0x7f) return [0x80 | length];
	return [0x40 | (length >> 8), length & 0xff];
}

export function el(elementId: number, body: number[], unknownSize = false) {
	return [
		...id(elementId),
		...(unknownSize ? UNKNOWN : size(body.length)),
		...body,
	];
}

function uint(value: number, bytes: number) {
	const out: number[] = [];
	for (let index = bytes - 1; index >= 0; index--) {
		out.push(Math.floor(value / 256 ** index) & 0xff);
	}
	return out;
}

export const header = el(
	0x1a45dfa3,
	el(0x4282, [...new TextEncoder().encode("webm")]),
);
export const info = el(0x1549a966, el(0x2ad7b1, uint(1_000_000, 3)));
export const tracks = el(0x1654ae6b, el(0xae, el(0xd7, [1])));

export function cluster(
	timecodeMs: number,
	blocks = 3,
	known = false,
	blockBytes = 40,
) {
	const body = [
		...el(0xe7, uint(timecodeMs, 4)),
		...Array.from({ length: blocks }, (_, index) =>
			el(0xa3, [
				0x81,
				0,
				index * 20,
				0x80,
				...new Array(blockBytes).fill(0x55),
			]),
		).flat(),
	];
	return el(0x1f43b675, body, !known);
}

/// Clusters five seconds apart.
export function recording(
	clusters: number,
	known = false,
	blocks = 3,
	blockBytes = 40,
) {
	const segment = [
		...info,
		...tracks,
		...Array.from({ length: clusters }, (_, index) =>
			cluster(index * 5000, blocks, known, blockBytes),
		).flat(),
	];
	return new Uint8Array([...header, ...el(0x18538067, segment, true)]);
}
