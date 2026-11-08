const u32 = (value: number) => {
	const bytes = new Uint8Array(4);
	new DataView(bytes.buffer).setUint32(0, value);
	return bytes;
};

const u64 = (value: number) => {
	const bytes = new Uint8Array(8);
	new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
	return bytes;
};

function concat(parts: Uint8Array[]) {
	const output = new Uint8Array(
		parts.reduce((sum, part) => sum + part.length, 0),
	);
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.length;
	}
	return output;
}

export function box(type: string, ...payload: Uint8Array[]) {
	const body = concat(payload);
	return concat([u32(body.length + 8), new TextEncoder().encode(type), body]);
}

function fullBox(
	type: string,
	version: number,
	flags: number,
	...payload: Uint8Array[]
) {
	return box(type, u32((version << 24) | flags), ...payload);
}

export function initSegment({
	timescale,
	defaultSampleDuration = 0,
	mdhdVersion = 0,
}: {
	timescale: number;
	defaultSampleDuration?: number;
	mdhdVersion?: 0 | 1;
}) {
	const mdhd =
		mdhdVersion === 1
			? fullBox("mdhd", 1, 0, u64(0), u64(0), u32(timescale), u64(0), u32(0))
			: fullBox("mdhd", 0, 0, u32(0), u32(0), u32(timescale), u32(0), u32(0));
	return concat([
		box("ftyp", new TextEncoder().encode("iso6"), u32(0)),
		box(
			"moov",
			fullBox("mvhd", 0, 0, new Uint8Array(96)),
			box("trak", box("mdia", mdhd, fullBox("hdlr", 0, 0, new Uint8Array(20)))),
			box(
				"mvex",
				fullBox(
					"trex",
					0,
					0,
					u32(1),
					u32(1),
					u32(defaultSampleDuration),
					u32(0),
					u32(0),
				),
			),
		),
	]);
}

export function moof({
	durations,
	count = durations?.length ?? 0,
	tfhdDefaultDuration,
}: {
	durations?: number[];
	count?: number;
	tfhdDefaultDuration?: number;
}) {
	const tfhdFlags = tfhdDefaultDuration === undefined ? 0 : 0x08;
	const tfhd = fullBox(
		"tfhd",
		0,
		tfhdFlags,
		u32(1),
		...(tfhdDefaultDuration === undefined ? [] : [u32(tfhdDefaultDuration)]),
	);
	const trunFlags = 0x01 | 0x200 | (durations ? 0x100 : 0);
	const samples = Array.from({ length: count }, (_, index) =>
		durations ? concat([u32(durations[index] ?? 0), u32(100)]) : u32(100),
	);
	const trun = fullBox("trun", 0, trunFlags, u32(count), u32(0), ...samples);
	return box("moof", fullBox("mfhd", 0, 0, u32(1)), box("traf", tfhd, trun));
}

export function mdat(size: number, { large = false } = {}) {
	if (!large)
		return concat([
			u32(size + 8),
			new TextEncoder().encode("mdat"),
			new Uint8Array(size),
		]);
	return concat([
		u32(1),
		new TextEncoder().encode("mdat"),
		u64(size + 16),
		new Uint8Array(size),
	]);
}

export function segment(...parts: Uint8Array[]) {
	return concat([
		box("styp", new TextEncoder().encode("msdh"), u32(0)),
		...parts,
	]);
}

export function rangeReader(bytes: Uint8Array) {
	const reads: [number, number][] = [];
	return {
		reads,
		read: async (start: number, end: number) => {
			reads.push([start, end]);
			return bytes.slice(start, end);
		},
	};
}
