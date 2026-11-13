import { open } from "node:fs/promises";
import { createGuardedMediaFetch, normalizeLocalPath } from "./media-common";

// A Matroska or WebM file that was never finalised (a recorder that stopped,
// FFmpeg writing to a pipe) has no Duration and no Cues, and finding its
// length by reading every cluster from the start takes as long as fetching
// the whole file. Its last cluster is near the end, so the length is read
// from there: one range read of the tail, whatever the file size.

// A cluster of high bitrate video can be larger than the first read, so a
// tail without a readable cluster is read once more, larger.
const TAIL_READS = [4 * 1024 * 1024, 32 * 1024 * 1024];
const HEAD_BYTES = 64 * 1024;
const MAX_CLUSTER_CANDIDATES = 64;
const DEFAULT_TIMECODE_SCALE_NS = 1_000_000;
const RANGE_TIMEOUT_MS = 10_000;

const CLUSTER_ID = [0x1f, 0x43, 0xb6, 0x75];
const TIMECODE_SCALE_ID = [0x2a, 0xd7, 0xb1];
const ID_CLUSTER = 0x1f43b675;
const ID_TIMECODE = 0xe7;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK_GROUP = 0xa0;
const ID_BLOCK = 0xa1;
const ID_CRC32 = 0xbf;
const ID_VOID = 0xec;

interface Vint {
	value: number;
	length: number;
	unknown: boolean;
}

function readVint(
	data: Uint8Array,
	at: number,
	keepMarker: boolean,
): Vint | null {
	const first = data[at];
	if (first === undefined || first === 0) return null;
	let length = 1;
	while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
	if (length > 8 || at + length > data.length) return null;
	let value = keepMarker ? first : first & (0xff >> length);
	let allOnes = (first & (0xff >> length)) === 0xff >> length;
	for (let i = 1; i < length; i++) {
		const byte = data[at + i] as number;
		value = value * 256 + byte;
		if (byte !== 0xff) allOnes = false;
	}
	return { value, length, unknown: !keepMarker && allOnes };
}

function readUint(data: Uint8Array, at: number, size: number): number | null {
	if (size < 1 || size > 8 || at + size > data.length) return null;
	let value = 0;
	for (let i = 0; i < size; i++) value = value * 256 + (data[at + i] as number);
	return value;
}

function indexesOf(data: Uint8Array, pattern: number[]): number[] {
	const found: number[] = [];
	for (let i = 0; i + pattern.length <= data.length; i++) {
		let match = true;
		for (let j = 0; j < pattern.length; j++) {
			if (data[i + j] !== pattern[j]) {
				match = false;
				break;
			}
		}
		if (match) found.push(i);
	}
	return found;
}

// The relative timestamp of a Block or SimpleBlock whose body starts at `at`.
function blockTimestamp(data: Uint8Array, at: number): number | null {
	const track = readVint(data, at, false);
	if (!track) return null;
	const offset = at + track.length;
	if (offset + 2 > data.length) return null;
	const raw = ((data[offset] as number) << 8) | (data[offset + 1] as number);
	return raw >= 0x8000 ? raw - 0x10000 : raw;
}

// The last block timestamp of the cluster starting at `at`, in timecode
// units, or null when this is not a cluster that can be read.
function lastTimestampInCluster(data: Uint8Array, at: number): number | null {
	const header = readVint(data, at + CLUSTER_ID.length, false);
	if (!header) return null;
	const start = at + CLUSTER_ID.length + header.length;
	const end = header.unknown
		? data.length
		: Math.min(data.length, start + header.value);
	let clusterTime: number | null = null;
	let last: number | null = null;
	let position = start;
	while (position < end) {
		const id = readVint(data, position, true);
		if (!id) break;
		const size = readVint(data, position + id.length, false);
		if (!size || size.unknown) break;
		const body = position + id.length + size.length;
		if (id.value === ID_CLUSTER) break;
		if (id.value === ID_TIMECODE) {
			clusterTime = readUint(data, body, size.value);
			if (clusterTime === null) return null;
		} else if (clusterTime === null) {
			// The cluster timestamp comes first, after at most a checksum or
			// padding.
			if (id.value !== ID_CRC32 && id.value !== ID_VOID) return null;
		} else if (id.value === ID_SIMPLE_BLOCK) {
			const relative = blockTimestamp(data, body);
			if (relative !== null) last = Math.max(last ?? -Infinity, relative);
		} else if (id.value === ID_BLOCK_GROUP) {
			let child = body;
			const groupEnd = Math.min(data.length, body + size.value);
			while (child < groupEnd) {
				const childId = readVint(data, child, true);
				const childSize =
					childId && readVint(data, child + childId.length, false);
				if (!childId || !childSize || childSize.unknown) break;
				const childBody = child + childId.length + childSize.length;
				if (childId.value === ID_BLOCK) {
					const relative = blockTimestamp(data, childBody);
					if (relative !== null) last = Math.max(last ?? -Infinity, relative);
				}
				child = childBody + childSize.value;
			}
		} else if (id.value > 0xffffff) {
			// Another top-level element (Cues, Tags) ends the cluster.
			break;
		}
		position = body + size.value;
	}
	return clusterTime === null || last === null ? null : clusterTime + last;
}

// The last block timestamp in the tail of a Matroska file, in timecode units.
export function lastBlockTimestamp(tail: Uint8Array): number | null {
	const candidates = indexesOf(tail, CLUSTER_ID).reverse();
	for (const at of candidates.slice(0, MAX_CLUSTER_CANDIDATES)) {
		const timestamp = lastTimestampInCluster(tail, at);
		if (timestamp !== null) return timestamp;
	}
	return null;
}

export function timecodeScaleNs(head: Uint8Array): number {
	for (const at of indexesOf(head, TIMECODE_SCALE_ID)) {
		const size = readVint(head, at + TIMECODE_SCALE_ID.length, false);
		if (!size) continue;
		const value = readUint(
			head,
			at + TIMECODE_SCALE_ID.length + size.length,
			size.value,
		);
		if (value !== null && value >= 1 && value <= 1_000_000_000) return value;
	}
	return DEFAULT_TIMECODE_SCALE_NS;
}

async function readRemoteRange(
	path: string,
	range: string,
	limit: number,
): Promise<Uint8Array | null> {
	const response = await createGuardedMediaFetch(path)(path, {
		headers: { Range: range },
		signal: AbortSignal.timeout(RANGE_TIMEOUT_MS),
	});
	// A server that ignores the range would send the whole file.
	if (response.status !== 206) {
		await response.body?.cancel().catch(() => {});
		return null;
	}
	const reader = response.body?.getReader();
	if (!reader) return null;
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (length < limit) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			length += value.length;
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	const bytes = new Uint8Array(Math.min(length, limit));
	let offset = 0;
	for (const chunk of chunks) {
		const part = chunk.subarray(0, bytes.length - offset);
		bytes.set(part, offset);
		offset += part.length;
		if (offset >= bytes.length) break;
	}
	return bytes;
}

async function readLocalRange(
	path: string,
	from: "head" | "tail",
	bytes: number,
): Promise<Uint8Array> {
	const handle = await open(normalizeLocalPath(path), "r");
	try {
		const { size } = await handle.stat();
		const length = Math.min(bytes, size);
		const buffer = new Uint8Array(length);
		await handle.read(buffer, 0, length, from === "head" ? 0 : size - length);
		return buffer;
	} finally {
		await handle.close();
	}
}

async function readHead(path: string): Promise<Uint8Array | null> {
	return /^https?:\/\//i.test(path)
		? await readRemoteRange(path, `bytes=0-${HEAD_BYTES - 1}`, HEAD_BYTES)
		: await readLocalRange(path, "head", HEAD_BYTES);
}

async function readTail(
	path: string,
	bytes: number,
): Promise<Uint8Array | null> {
	return /^https?:\/\//i.test(path)
		? await readRemoteRange(path, `bytes=-${bytes}`, bytes)
		: await readLocalRange(path, "tail", bytes);
}

// How much of a tail must be zero bytes for it to count as blank: what a
// recorder that preallocated its file and stopped leaves behind.
const BLANK_TAIL_BYTES = 64 * 1024;

function endsBlank(tail: Uint8Array): boolean {
	if (tail.length < BLANK_TAIL_BYTES) return false;
	for (let i = tail.length - BLANK_TAIL_BYTES; i < tail.length; i++) {
		if (tail[i] !== 0) return false;
	}
	return true;
}

// The time of the last block in a Matroska or WebM file, in seconds, from
// its first 64 KB and its last few megabytes. "blank" when the file ends in
// zero bytes, null when no cluster starts in the tail (the file was cut off,
// or its last cluster is larger than the read), undefined when the source
// cannot be read by range. A failed read throws.
export async function matroskaEndFromTail(
	path: string,
): Promise<number | "blank" | null | undefined> {
	const head = await readHead(path);
	if (!head) return undefined;
	for (const bytes of TAIL_READS) {
		const tail = await readTail(path, bytes);
		if (!tail) return undefined;
		if (endsBlank(tail)) return "blank";
		const last = lastBlockTimestamp(tail);
		if (last !== null) return (last * timecodeScaleNs(head)) / 1_000_000_000;
		// The whole file was read and holds no cluster.
		if (tail.length < bytes) return null;
	}
	return null;
}
