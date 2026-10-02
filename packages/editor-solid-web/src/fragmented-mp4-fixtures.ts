/// Builders for small fragmented MP4 files used by the seek tests.

export function u32(value: number) {
	const bytes = new Uint8Array(4);
	new DataView(bytes.buffer).setUint32(0, value);
	return bytes;
}

export function u64(value: number) {
	const bytes = new Uint8Array(8);
	new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
	return bytes;
}

export function concat(...parts: Uint8Array[]) {
	const out = new Uint8Array(parts.reduce((n, part) => n + part.byteLength, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.byteLength;
	}
	return out;
}

export function box(type: string, ...body: Uint8Array[]) {
	const content = concat(...body);
	return concat(
		u32(content.byteLength + 8),
		new TextEncoder().encode(type),
		content,
	);
}

export function fullBox(
	type: string,
	version: number,
	flags: number,
	...body: Uint8Array[]
) {
	return box(type, u32((version << 24) | flags), ...body);
}

export function trak(
	id: number,
	handler: string,
	timescale: number,
	edits = false,
) {
	return box(
		"trak",
		fullBox("tkhd", 0, 3, u32(0), u32(0), u32(id)),
		...(edits ? [box("edts")] : []),
		box(
			"mdia",
			fullBox("mdhd", 0, 0, u32(0), u32(0), u32(timescale), u32(0)),
			fullBox("hdlr", 0, 0, u32(0), new TextEncoder().encode(handler), u32(0)),
		),
	);
}

export function init(options: { edits?: boolean } = {}) {
	return concat(
		box("ftyp", new TextEncoder().encode("isom"), u32(0)),
		box(
			"moov",
			trak(1, "soun", 48000),
			trak(2, "vide", 15360, options.edits),
			box(
				"mvex",
				fullBox("trex", 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0)),
				fullBox("trex", 0, 0, u32(2), u32(1), u32(512), u32(0), u32(0x10000)),
			),
		),
	);
}

export function fragment(
	decodeTime: number,
	options: {
		keyframe?: boolean;
		payload?: number;
		absoluteBase?: boolean;
	} = {},
) {
	const firstFlags = options.keyframe === false ? 0x10000 : 0x2000000;
	const moof = box(
		"moof",
		fullBox("mfhd", 0, 0, u32(1)),
		box(
			"traf",
			fullBox("tfhd", 0, 0x20000, u32(1)),
			fullBox("tfdt", 1, 0, u64(decodeTime * 3.125)),
			fullBox("trun", 0, 0x301, u32(1), u32(0), u32(1024), u32(10)),
		),
		box(
			"traf",
			options.absoluteBase
				? fullBox("tfhd", 0, 0x1, u32(2), u64(0))
				: fullBox("tfhd", 0, 0x20000, u32(2)),
			fullBox("tfdt", 1, 0, u64(decodeTime)),
			fullBox("trun", 0, 0x5, u32(30), u32(0), u32(firstFlags)),
		),
	);
	return concat(moof, box("mdat", new Uint8Array(options.payload ?? 2000)));
}

export function recording(fragments: number, seconds = 2) {
	const parts = [init()];
	for (let index = 0; index < fragments; index++) {
		parts.push(
			fragment(index * seconds * 15360, { payload: 1500 + (index % 7) * 300 }),
		);
	}
	return concat(...parts);
}
