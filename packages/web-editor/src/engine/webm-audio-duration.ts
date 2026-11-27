const EBML = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const TIMECODE_SCALE = 0x2ad7b1;
const CLUSTER = 0x1f43b675;
const TIMECODE = 0xe7;
const SIMPLE_BLOCK = 0xa3;
const BLOCK_GROUP = 0xa0;
const BLOCK = 0xa1;
const BLOCK_DURATION = 0x9b;
const TRACKS = 0x1654ae6b;
const TRACK_ENTRY = 0xae;
const TRACK_NUMBER = 0xd7;
const DEFAULT_DURATION = 0x23e383;
const UNKNOWN_SIZE = -1;

function vint(bytes: Uint8Array, offset: number, keepMarker: boolean) {
	const first = bytes[offset];
	if (first === undefined || first === 0) return null;
	const length = Math.clz32(first) - 23;
	if (offset + length > bytes.length) return null;
	let value = keepMarker ? first : first & (0xff >> length);
	let allOnes = value === 0xff >> length;
	for (let index = 1; index < length; index++) {
		const byte = bytes[offset + index] ?? 0;
		value = value * 256 + byte;
		allOnes &&= byte === 0xff;
	}
	return { value: !keepMarker && allOnes ? UNKNOWN_SIZE : value, length };
}

function element(bytes: Uint8Array, offset: number) {
	const id = vint(bytes, offset, true);
	const size = id && vint(bytes, offset + id.length, false);
	if (!id || !size) return null;
	const body = offset + id.length + size.length;
	return {
		id: id.value,
		body,
		end: size.value === UNKNOWN_SIZE ? bytes.length : body + size.value,
		unknownSize: size.value === UNKNOWN_SIZE,
	};
}

function unsigned(bytes: Uint8Array, start: number, end: number) {
	let value = 0;
	for (let index = start; index < end; index++)
		value = value * 256 + (bytes[index] ?? 0);
	return value;
}

function groupDuration(
	bytes: Uint8Array,
	group: { body: number; end: number },
) {
	for (let field = group.body; field < group.end; ) {
		const value = element(bytes, field);
		if (!value || value.end > group.end) return null;
		if (value.id === BLOCK_DURATION)
			return unsigned(bytes, value.body, value.end);
		field = value.end;
	}
	return null;
}

export function webmTimecodeScale(head: Uint8Array) {
	const header = element(head, 0);
	const segment = header && element(head, header.end);
	if (header?.id !== EBML || segment?.id !== SEGMENT) return null;
	let position = segment.body;
	while (position < head.length) {
		const child = element(head, position);
		if (!child || child.id === CLUSTER || child.unknownSize) break;
		if (child.id === INFO) {
			let field = child.body;
			while (field < child.end) {
				const entry = element(head, field);
				if (!entry || entry.end > child.end) return null;
				if (entry.id === TIMECODE_SCALE) {
					return unsigned(head, entry.body, entry.end) || null;
				}
				field = entry.end;
			}
			return 1_000_000;
		}
		position = child.end;
	}
	return null;
}

export function webmDefaultDurations(head: Uint8Array) {
	const header = element(head, 0);
	const segment = header && element(head, header.end);
	if (header?.id !== EBML || segment?.id !== SEGMENT) return null;
	for (let position = segment.body; position < head.length; ) {
		const child = element(head, position);
		if (!child || child.id === CLUSTER || child.unknownSize) return null;
		if (child.id === TRACKS) {
			if (child.end > head.length) return null;
			const durations = new Map<number, number>();
			for (let entry = child.body; entry < child.end; ) {
				const track = element(head, entry);
				if (!track || track.end > child.end) return null;
				if (track.id === TRACK_ENTRY) {
					let number: number | null = null;
					let duration: number | null = null;
					for (let field = track.body; field < track.end; ) {
						const value = element(head, field);
						if (!value || value.end > track.end) return null;
						if (value.id === TRACK_NUMBER)
							number = unsigned(head, value.body, value.end);
						if (value.id === DEFAULT_DURATION)
							duration = unsigned(head, value.body, value.end);
						field = value.end;
					}
					if (number !== null && duration !== null)
						durations.set(number, duration);
				}
				entry = track.end;
			}
			return durations;
		}
		position = child.end;
	}
	return null;
}

// mediabunny reports a MediaRecorder WebM's duration (no Duration, no Cues)
// as the last block's timestamp for audio and as that block's end for video;
// `defaultDurations` selects the latter.
export function webmEnd(
	tail: Uint8Array,
	timecodeScale: number,
	defaultDurations?: Map<number, number>,
) {
	for (let offset = tail.length - 8; offset >= 0; offset--) {
		if (
			tail[offset] !== 0x1f ||
			tail[offset + 1] !== 0x43 ||
			tail[offset + 2] !== 0xb6 ||
			tail[offset + 3] !== 0x75
		) {
			continue;
		}
		const cluster = element(tail, offset);
		if (cluster?.id !== CLUSTER || cluster.end !== tail.length) continue;
		let clusterTime: number | null = null;
		let last: number | null = null;
		let position = cluster.body;
		let valid = true;
		while (position < cluster.end) {
			const child = element(tail, position);
			if (!child || child.unknownSize || child.end > cluster.end) {
				valid = false;
				break;
			}
			if (child.id === TIMECODE) {
				clusterTime = unsigned(tail, child.body, child.end);
			} else if (child.id === SIMPLE_BLOCK || child.id === BLOCK_GROUP) {
				const block =
					child.id === SIMPLE_BLOCK
						? child
						: (() => {
								const inner = element(tail, child.body);
								return inner?.id === BLOCK ? inner : null;
							})();
				const track = block && vint(tail, block.body, false);
				if (!block || !track || clusterTime === null) {
					valid = false;
					break;
				}
				const at = block.body + track.length;
				const relative = (((tail[at] ?? 0) << 24) >> 16) | (tail[at + 1] ?? 0);
				const start = ((clusterTime + relative) * timecodeScale) / 1e9;
				let length = 0;
				if (defaultDurations) {
					const blockDuration =
						child.id === BLOCK_GROUP ? groupDuration(tail, child) : null;
					length =
						blockDuration !== null
							? (blockDuration * timecodeScale) / 1e9
							: (defaultDurations.get(track.value) ?? 0) / 1e9;
				}
				last = Math.max(last ?? 0, start + length);
			}
			position = child.end;
		}
		if (valid && position === cluster.end && last !== null) return last;
	}
	return null;
}
