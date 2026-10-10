const EBML = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const TIMECODE_SCALE = 0x2ad7b1;
const CLUSTER = 0x1f43b675;
const TIMECODE = 0xe7;
const SIMPLE_BLOCK = 0xa3;
const BLOCK_GROUP = 0xa0;
const BLOCK = 0xa1;
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

/// `TimecodeScale` from the start of a WebM (1 ms when absent), or null when
/// the bytes do not start with a WebM segment.
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

/// Timestamp in seconds of the last block in the final cluster of a WebM
/// whose last bytes are `tail`, which is what mediabunny reports as the
/// duration of a MediaRecorder audio file (no `Duration`, no `Cues`). Null
/// unless the cluster parses cleanly to the end of the file.
export function webmEnd(tail: Uint8Array, timecodeScale: number) {
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
				last = Math.max(last ?? 0, clusterTime + relative);
			}
			position = child.end;
		}
		if (valid && position === cluster.end && last !== null) {
			return (last * timecodeScale) / 1e9;
		}
	}
	return null;
}
