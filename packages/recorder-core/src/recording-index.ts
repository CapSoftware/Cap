/// A seek index for a recording, built from its bytes as they stream past and
/// appended once it ends: an `mfra` for fragmented MP4, Cues behind a short
/// trailer for WebM. MediaRecorder writes neither, so without one a reader
/// finds a time by walking the file from its start.
export type RecordingIndexer = {
	/// File offset of the next byte the indexer reads; the bytes before it are
	/// either consumed or not needed (sample data it skips).
	readonly position: number;
	/// How many bytes from `position` a read should fetch at least.
	readonly wanted: number;
	/// The bytes so far can't take an index; nothing more needs reading.
	readonly failed: boolean;
	/// Bytes of the file starting at `position`.
	push(bytes: Uint8Array): void;
	/// The index to append to a recording of `total` bytes, or null when the
	/// bytes can't take one (not the expected container, already indexed, or
	/// not ending on a whole box or element).
	finish(total: number): Uint8Array<ArrayBuffer> | null;
};

/// Longest box or element header the indexers keep whole while waiting for
/// more bytes: a `moov` or `moof`, or a WebM Tracks element.
const MAX_HELD_BYTES = 16 * 1024 * 1024;

function concat(left: Uint8Array | null, right: Uint8Array) {
	if (!left || left.byteLength === 0) return right;
	const out = new Uint8Array(left.byteLength + right.byteLength);
	out.set(left);
	out.set(right, left.byteLength);
	return out;
}

function fourcc(bytes: Uint8Array, at: number) {
	return String.fromCharCode(
		bytes[at] ?? 0,
		bytes[at + 1] ?? 0,
		bytes[at + 2] ?? 0,
		bytes[at + 3] ?? 0,
	);
}

type Box = { type: string; start: number; body: number; end: number };

function boxesIn(view: DataView, start: number, end: number) {
	const out: Box[] = [];
	let offset = start;
	while (offset + 8 <= end) {
		let size = view.getUint32(offset);
		let body = offset + 8;
		if (size === 1) {
			if (offset + 16 > end) return null;
			size = Number(view.getBigUint64(offset + 8));
			body = offset + 16;
		}
		if (size < body - offset || offset + size > end) return null;
		out.push({
			type: fourcc(
				new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
				offset + 4,
			),
			start: offset,
			body,
			end: offset + size,
		});
		offset += size;
	}
	return offset === end ? out : null;
}

type Mp4Track = {
	id: number;
	handler: string;
	defaultDuration: number;
	defaultFlags: number;
};

type TfraEntry = {
	time: number;
	moof: number;
	traf: number;
	trun: number;
	sample: number;
};

const NON_SYNC_SAMPLE = 0x10000;

function mp4Tracks(moov: Uint8Array) {
	const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
	const top = boxesIn(view, 8, moov.byteLength);
	if (!top) return null;
	const mvex = top.find((box) => box.type === "mvex");
	if (!mvex) return null;
	const tracks: Mp4Track[] = [];
	for (const trak of top.filter((box) => box.type === "trak")) {
		const trakBoxes = boxesIn(view, trak.body, trak.end);
		const tkhd = trakBoxes?.find((box) => box.type === "tkhd");
		const mdia = trakBoxes?.find((box) => box.type === "mdia");
		const hdlr =
			mdia &&
			boxesIn(view, mdia.body, mdia.end)?.find((box) => box.type === "hdlr");
		if (!tkhd || !hdlr || hdlr.body + 12 > hdlr.end) continue;
		const version = view.getUint8(tkhd.body);
		tracks.push({
			id: view.getUint32(tkhd.body + (version === 1 ? 20 : 12)),
			handler: fourcc(moov, hdlr.body + 8),
			defaultDuration: 0,
			defaultFlags: 0,
		});
	}
	for (const trex of boxesIn(view, mvex.body, mvex.end) ?? []) {
		if (trex.type !== "trex" || trex.body + 24 > trex.end) continue;
		const track = tracks.find(
			(candidate) => candidate.id === view.getUint32(trex.body + 4),
		);
		if (!track) continue;
		track.defaultDuration = view.getUint32(trex.body + 12);
		track.defaultFlags = view.getUint32(trex.body + 20);
	}
	return tracks;
}

/// The first sync sample of `track` in a `moof` at file offset `offset`, as
/// the `tfra` entry that points at it; null when the fragment holds none.
/// Throws on a `moof` it can't read.
function moofEntry(
	moof: Uint8Array,
	offset: number,
	track: Mp4Track,
): TfraEntry | null {
	const view = new DataView(moof.buffer, moof.byteOffset, moof.byteLength);
	const trafs = boxesIn(view, 8, moof.byteLength)?.filter(
		(box) => box.type === "traf",
	);
	if (!trafs) throw new Error("Unreadable moof");
	for (const [trafIndex, traf] of trafs.entries()) {
		const children = boxesIn(view, traf.body, traf.end);
		const tfhd = children?.find((box) => box.type === "tfhd");
		if (!children || !tfhd || tfhd.body + 8 > tfhd.end) {
			throw new Error("Unreadable traf");
		}
		if (view.getUint32(tfhd.body + 4) !== track.id) continue;
		const tfhdFlags = view.getUint32(tfhd.body) & 0xffffff;
		let field = tfhd.body + 8;
		if (tfhdFlags & 0x1) field += 8;
		if (tfhdFlags & 0x2) field += 4;
		const fields =
			+((tfhdFlags & 0x8) !== 0) +
			+((tfhdFlags & 0x10) !== 0) +
			+((tfhdFlags & 0x20) !== 0);
		if (field + 4 * fields > tfhd.end) throw new Error("Short tfhd");
		let defaultDuration = track.defaultDuration;
		if (tfhdFlags & 0x8) {
			defaultDuration = view.getUint32(field);
			field += 4;
		}
		if (tfhdFlags & 0x10) field += 4;
		const defaultFlags =
			tfhdFlags & 0x20 ? view.getUint32(field) : track.defaultFlags;
		const tfdt = children.find((box) => box.type === "tfdt");
		if (
			!tfdt ||
			tfdt.body + (view.getUint8(tfdt.body) === 1 ? 12 : 8) > tfdt.end
		)
			throw new Error("Fragment without a decode time");
		let decodeTime =
			view.getUint8(tfdt.body) === 1
				? Number(view.getBigUint64(tfdt.body + 4))
				: view.getUint32(tfdt.body + 4);
		const truns = children.filter((box) => box.type === "trun");
		for (const [trunIndex, trun] of truns.entries()) {
			const version = view.getUint8(trun.body);
			const flags = view.getUint32(trun.body) & 0xffffff;
			const count = view.getUint32(trun.body + 4);
			let at = trun.body + 8;
			if (flags & 0x1) at += 4;
			if (at + (flags & 0x4 ? 4 : 0) > trun.end) throw new Error("Short trun");
			let firstFlags: number | null = null;
			if (flags & 0x4) {
				firstFlags = view.getUint32(at);
				at += 4;
			}
			const hasDuration = (flags & 0x100) !== 0;
			const hasSize = (flags & 0x200) !== 0;
			const hasFlags = (flags & 0x400) !== 0;
			const hasOffset = (flags & 0x800) !== 0;
			const stride = 4 * (+hasDuration + +hasSize + +hasFlags + +hasOffset);
			if (at + count * stride > trun.end) throw new Error("Short trun");
			for (let sample = 0; sample < count; sample++) {
				let cursor = at + sample * stride;
				const duration = hasDuration ? view.getUint32(cursor) : defaultDuration;
				if (hasDuration) cursor += 4;
				if (hasSize) cursor += 4;
				let sampleFlags =
					sample === 0 && firstFlags !== null ? firstFlags : defaultFlags;
				if (hasFlags) {
					sampleFlags = view.getUint32(cursor);
					cursor += 4;
				}
				const compositionOffset = hasOffset
					? version === 1
						? view.getInt32(cursor)
						: view.getUint32(cursor)
					: 0;
				if ((sampleFlags & NON_SYNC_SAMPLE) === 0) {
					return {
						time: Math.max(0, decodeTime + compositionOffset),
						moof: offset,
						traf: trafIndex + 1,
						trun: trunIndex + 1,
						sample: sample + 1,
					};
				}
				decodeTime += duration;
			}
		}
		return null;
	}
	return null;
}

function byteCount(value: number) {
	if (value < 0x100) return 1;
	if (value < 0x10000) return 2;
	if (value < 0x1000000) return 3;
	return 4;
}

function writeUint(view: DataView, at: number, bytes: number, value: number) {
	for (let index = bytes - 1; index >= 0; index--) {
		view.setUint8(at + index, value & 0xff);
		value = Math.floor(value / 256);
	}
}

/// An `mfra` holding one `tfra` for `trackId` and its `mfro`.
export function buildMfra(trackId: number, entries: TfraEntry[]) {
	let wide = false;
	let traf = 1;
	let trun = 1;
	let sample = 1;
	for (const entry of entries) {
		wide ||= entry.time > 0xffffffff || entry.moof > 0xffffffff;
		traf = Math.max(traf, entry.traf);
		trun = Math.max(trun, entry.trun);
		sample = Math.max(sample, entry.sample);
	}
	const trafBytes = byteCount(traf);
	const trunBytes = byteCount(trun);
	const sampleBytes = byteCount(sample);
	const entryBytes = (wide ? 16 : 8) + trafBytes + trunBytes + sampleBytes;
	const tfraBytes = 24 + entries.length * entryBytes;
	const total = 8 + tfraBytes + 16;
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	const header = (at: number, size: number, type: string) => {
		view.setUint32(at, size);
		for (let index = 0; index < 4; index++) {
			view.setUint8(at + 4 + index, type.charCodeAt(index));
		}
	};
	header(0, total, "mfra");
	header(8, tfraBytes, "tfra");
	view.setUint32(16, wide ? 0x01000000 : 0);
	view.setUint32(20, trackId);
	view.setUint32(
		24,
		((trafBytes - 1) << 4) | ((trunBytes - 1) << 2) | (sampleBytes - 1),
	);
	view.setUint32(28, entries.length);
	let at = 32;
	for (const entry of entries) {
		if (wide) {
			view.setBigUint64(at, BigInt(entry.time));
			view.setBigUint64(at + 8, BigInt(entry.moof));
			at += 16;
		} else {
			view.setUint32(at, entry.time);
			view.setUint32(at + 4, entry.moof);
			at += 8;
		}
		writeUint(view, at, trafBytes, entry.traf);
		at += trafBytes;
		writeUint(view, at, trunBytes, entry.trun);
		at += trunBytes;
		writeUint(view, at, sampleBytes, entry.sample);
		at += sampleBytes;
	}
	header(at, 16, "mfro");
	view.setUint32(at + 12, total);
	return out;
}

/// Walks a fragmented MP4's top-level boxes, reading the `moov` and each
/// `moof` and skipping sample data, and lists the fragment holding each sync
/// sample of the video track (the audio track in an audio-only file).
export class Mp4Indexer implements RecordingIndexer {
	private next = 0;
	private held: Uint8Array | null = null;
	failed = false;
	private track: Mp4Track | null = null;
	private readonly entries: TfraEntry[] = [];

	get position() {
		return this.next + (this.held?.byteLength ?? 0);
	}

	get wanted() {
		return 16 * 1024;
	}

	push(bytes: Uint8Array) {
		if (this.failed || bytes.byteLength === 0) return;
		const data = concat(this.held, bytes);
		this.held = null;
		const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
		let at = 0;
		while (at < data.byteLength) {
			if (data.byteLength - at < 8) break;
			let size = view.getUint32(at);
			let header = 8;
			if (size === 1) {
				if (data.byteLength - at < 16) break;
				size = Number(view.getBigUint64(at + 8));
				header = 16;
			}
			const type = fourcc(data, at + 4);
			if (size < header || type === "mfra") {
				this.failed = true;
				return;
			}
			if (type === "moov" || type === "moof") {
				if (size > MAX_HELD_BYTES) {
					this.failed = true;
					return;
				}
				if (data.byteLength - at < size) break;
				try {
					this.readBox(type, data.subarray(at, at + size));
				} catch {
					this.failed = true;
					return;
				}
				if (this.failed) return;
			}
			this.next += size;
			at += size;
		}
		if (at < data.byteLength) this.held = data.slice(at);
	}

	private readBox(type: string, box: Uint8Array) {
		if (type === "moov") {
			const tracks = mp4Tracks(box);
			this.track =
				tracks?.find((track) => track.handler === "vide") ??
				tracks?.find((track) => track.handler === "soun") ??
				null;
			if (!this.track) this.failed = true;
			return;
		}
		if (!this.track) {
			this.failed = true;
			return;
		}
		const entry = moofEntry(box, this.next, this.track);
		if (entry) this.entries.push(entry);
	}

	finish(total: number) {
		if (
			this.failed ||
			!this.track ||
			this.held !== null ||
			this.next !== total ||
			this.entries.length === 0
		) {
			return null;
		}
		return buildMfra(this.track.id, this.entries);
	}
}

const EBML_HEADER = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const CLUSTER = 0x1f43b675;
const CUES = 0x1c53bb6b;
const TRACKS = 0x1654ae6b;
const TRACK_ENTRY = 0xae;
const TRACK_NUMBER = 0xd7;
const TRACK_TYPE = 0x83;
const TIMECODE = 0xe7;
const SIMPLE_BLOCK = 0xa3;
const VIDEO_TRACK = 1;
const AUDIO_TRACK = 2;
/// Elements that end a cluster of unknown size: the Segment's own children.
const SEGMENT_CHILDREN = new Set([
	CLUSTER,
	CUES,
	TRACKS,
	0x114d9b74,
	0x1549a966,
	0x1254c367,
	0x1043a770,
	0x1941a469,
]);
/// An audio-only recording writes a cluster about every second; a reader
/// finds its place from any cue within this many bytes, so cues closer than
/// this would only lengthen the index it reads first.
const MIN_AUDIO_CUE_SPACING = 128 * 1024;

/// Last bytes of a WebM recording indexed here: a Void element whose body is
/// "cues", the timecode of each track's last block (track number, then eight
/// bytes), how many tracks that lists, and the length of the Cues element right
/// before it. A reader of the file's end finds the Cues without a SeekHead, and
/// the recording's end without reading its last cluster, which a recorder
/// writes megabytes long.
export function webmCuesTrailerBytes(tracks: number) {
	return 2 + 13 + 9 * tracks;
}

type Vint = { value: number; length: number; unknown: boolean };

function readVint(bytes: Uint8Array, at: number, marker: boolean): Vint | null {
	const first = bytes[at];
	if (first === undefined) return null;
	if (first === 0) return { value: 0, length: 9, unknown: false };
	const length = Math.clz32(first) - 23;
	if (at + length > bytes.byteLength) return null;
	let value = marker ? first : first & (0xff >> length);
	let ones = value === 0xff >> length;
	for (let index = 1; index < length; index++) {
		const byte = bytes[at + index] ?? 0;
		value = value * 256 + byte;
		ones &&= byte === 0xff;
	}
	return { value, length, unknown: !marker && ones };
}

function uintBytes(value: number) {
	const out: number[] = [];
	do {
		out.unshift(value % 256);
		value = Math.floor(value / 256);
	} while (value > 0);
	return out;
}

function ebml(id: number[], body: number[]) {
	if (body.length > 126) throw new Error("Element too long for a short size");
	return [...id, 0x80 | body.length, ...body];
}

type Cue = { time: number; cluster: number };

/// A Cues element listing `cues` for `track`, then the trailer that points
/// back to it.
export function buildWebmCues(
	track: number,
	cues: Cue[],
	ends: Map<number, number> = new Map(),
) {
	const points: number[] = [];
	for (const cue of cues) {
		const positions = ebml(
			[0xb7],
			[
				...ebml([0xf7], uintBytes(track)),
				...ebml([0xf1], uintBytes(cue.cluster)),
			],
		);
		points.push(
			...ebml([0xbb], [...ebml([0xb3], uintBytes(cue.time)), ...positions]),
		);
	}
	const length = 12 + points.length;
	const tracks = [...ends].filter(
		([number, end]) => number > 0 && number < 256 && end >= 0,
	);
	const trailer = webmCuesTrailerBytes(tracks.length);
	const out = new Uint8Array(length + trailer);
	out.set([0x1c, 0x53, 0xbb, 0x6b, 0x01]);
	const view = new DataView(out.buffer);
	writeUint(view, 5, 7, points.length);
	out.set(points, 12);
	out.set([0xec, 0x80 | (trailer - 2), 0x63, 0x75, 0x65, 0x73], length);
	let at = length + 6;
	for (const [number, end] of tracks) {
		view.setUint8(at, number);
		view.setBigUint64(at + 1, BigInt(end));
		at += 9;
	}
	view.setUint8(at, tracks.length);
	view.setBigUint64(at + 1, BigInt(length));
	return out;
}

/// Walks a WebM written while recording (a Segment of unknown size), reading
/// the Tracks and each cluster's timecode and block headers and skipping
/// frame data, and lists the clusters that start with a key frame of the
/// video track (the audio track in an audio-only file).
export class WebmIndexer implements RecordingIndexer {
	private next = 0;
	private held: Uint8Array | null = null;
	failed = false;
	private segmentBody: number | null = null;
	private track: { number: number; video: boolean } | null = null;
	private clusterEnd: number | null = null;
	private inCluster = false;
	private clusterStart = 0;
	private clusterTime: number | null = null;
	private clusterDecided = false;
	private readonly cues: Cue[] = [];
	/// Each track's latest block timecode; null once a BlockGroup (whose
	/// duration the ends would leave out) turns up.
	private ends: Map<number, number> | null = new Map();

	get position() {
		return this.next + (this.held?.byteLength ?? 0);
	}

	get wanted() {
		return 1024 * 1024;
	}

	push(bytes: Uint8Array) {
		if (this.failed || bytes.byteLength === 0) return;
		const data = concat(this.held, bytes);
		this.held = null;
		let at = 0;
		while (at < data.byteLength && !this.failed) {
			const used = this.step(data, at);
			if (used === null) break;
			at += used;
			this.next += used;
		}
		if (this.failed) return;
		if (at < data.byteLength) this.held = data.slice(at);
	}

	private fail() {
		this.failed = true;
		return null;
	}

	/// Consumes one element (or its header, when it is entered or skipped)
	/// starting at `at`; how many bytes, or null when more are needed. A
	/// skipped body may run past `data`, which `next` then jumps over.
	private step(data: Uint8Array, at: number): number | null {
		if (this.clusterEnd !== null && this.next > this.clusterEnd) {
			return this.fail();
		}
		if (this.clusterEnd !== null && this.next === this.clusterEnd) {
			this.closeCluster();
		}
		const id = readVint(data, at, true);
		if (!id) return null;
		if (id.length > 4) return this.fail();
		const size = readVint(data, at + id.length, false);
		if (!size) return null;
		if (size.length > 8) return this.fail();
		const header = id.length + size.length;
		if (this.segmentBody === null) {
			if (id.value === EBML_HEADER && !size.unknown) {
				return header + size.value;
			}
			if (id.value === SEGMENT && size.unknown) {
				this.segmentBody = this.next + header;
				return header;
			}
			return this.fail();
		}
		if (this.inCluster && SEGMENT_CHILDREN.has(id.value)) {
			if (this.clusterEnd !== null) return this.fail();
			this.closeCluster();
		}
		if (!this.inCluster) {
			if (id.value === CUES || id.value === SEGMENT) return this.fail();
			if (size.unknown && id.value !== CLUSTER) return this.fail();
			if (id.value === CLUSTER) {
				if (!this.track) return this.fail();
				this.inCluster = true;
				this.clusterStart = this.next;
				this.clusterEnd = size.unknown ? null : this.next + header + size.value;
				this.clusterTime = null;
				this.clusterDecided = false;
				return header;
			}
			if (id.value === TRACKS) {
				if (size.value > MAX_HELD_BYTES) return this.fail();
				if (data.byteLength - at < header + size.value) return null;
				this.readTracks(data.subarray(at + header, at + header + size.value));
				return this.failed ? null : header + size.value;
			}
			return header + size.value;
		}
		if (size.unknown) return this.fail();
		const end = header + size.value;
		if (id.value === TIMECODE) {
			if (data.byteLength - at < end) return null;
			let time = 0;
			for (let index = at + header; index < at + end; index++) {
				time = time * 256 + (data[index] ?? 0);
			}
			this.clusterTime = time;
			return end;
		}
		if (id.value === SIMPLE_BLOCK) {
			const track = readVint(data, at + header, false);
			if (!track) return null;
			if (data.byteLength - at < header + track.length + 3) return null;
			if (this.clusterTime === null) return this.fail();
			const relative =
				(((data[at + header + track.length] ?? 0) << 24) >> 16) |
				(data[at + header + track.length + 1] ?? 0);
			const time = this.clusterTime + relative;
			if (this.ends)
				this.ends.set(
					track.value,
					Math.max(this.ends.get(track.value) ?? 0, time),
				);
			if (!this.clusterDecided && track.value === this.track?.number) {
				this.clusterDecided = true;
				const flags = data[at + header + track.length + 2] ?? 0;
				// Firefox leaves the key flag off audio blocks, every one of
				// which starts decoding.
				if (flags & 0x80 || !this.track?.video) this.addCue(time);
			}
			return end;
		}
		if (id.value === 0xa0) {
			this.clusterDecided = true;
			this.ends = null;
		}
		return end;
	}

	private addCue(time: number) {
		if (this.segmentBody === null || !this.track || time < 0) return;
		const cluster = this.clusterStart - this.segmentBody;
		const last = this.cues.at(-1);
		if (
			!this.track.video &&
			last &&
			cluster - last.cluster < MIN_AUDIO_CUE_SPACING
		) {
			return;
		}
		this.cues.push({ time, cluster });
	}

	private closeCluster() {
		this.inCluster = false;
		this.clusterEnd = null;
	}

	private readTracks(body: Uint8Array) {
		const entries: { number: number; type: number }[] = [];
		let at = 0;
		while (at < body.byteLength) {
			const id = readVint(body, at, true);
			const size = id && readVint(body, at + id.length, false);
			if (!id || !size || size.unknown) {
				this.failed = true;
				return;
			}
			const start = at + id.length + size.length;
			const end = start + size.value;
			if (end > body.byteLength) {
				this.failed = true;
				return;
			}
			if (id.value === TRACK_ENTRY) {
				let number = 0;
				let type = 0;
				let field = start;
				while (field < end) {
					const fieldId = readVint(body, field, true);
					const fieldSize =
						fieldId && readVint(body, field + fieldId.length, false);
					if (!fieldId || !fieldSize || fieldSize.unknown) {
						this.failed = true;
						return;
					}
					const valueStart = field + fieldId.length + fieldSize.length;
					const valueEnd = valueStart + fieldSize.value;
					if (valueEnd > end) {
						this.failed = true;
						return;
					}
					if (fieldId.value === TRACK_NUMBER || fieldId.value === TRACK_TYPE) {
						let value = 0;
						for (let index = valueStart; index < valueEnd; index++) {
							value = value * 256 + (body[index] ?? 0);
						}
						if (fieldId.value === TRACK_NUMBER) number = value;
						else type = value;
					}
					field = valueEnd;
				}
				entries.push({ number, type });
			}
			at = end;
		}
		const video = entries.find((entry) => entry.type === VIDEO_TRACK);
		const audio = entries.find((entry) => entry.type === AUDIO_TRACK);
		const chosen = video ?? audio;
		if (!chosen || chosen.number < 1) {
			this.failed = true;
			return;
		}
		this.track = { number: chosen.number, video: chosen === video };
	}

	finish(total: number) {
		if (
			this.failed ||
			!this.track ||
			this.held !== null ||
			this.next !== total ||
			(this.clusterEnd !== null && this.clusterEnd !== total) ||
			this.cues.length === 0
		) {
			return null;
		}
		return buildWebmCues(this.track.number, this.cues, this.ends ?? undefined);
	}
}

export function createRecordingIndexer(
	mimeType: string,
): RecordingIndexer | null {
	const container = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
	if (container === "video/mp4" || container === "audio/mp4") {
		return new Mp4Indexer();
	}
	if (container === "video/webm" || container === "audio/webm") {
		return new WebmIndexer();
	}
	return null;
}

/// Feeds the bytes of `blob`, which starts at file offset `start`, to
/// `indexer`, reading only the ranges it needs.
export async function indexBlob(
	indexer: RecordingIndexer,
	blob: Blob,
	start: number,
) {
	const end = start + blob.size;
	let guard = 0;
	while (!indexer.failed && indexer.position < end) {
		const from = indexer.position - start;
		if (from < 0) throw new Error("Recording index fell behind its bytes");
		const to = Math.min(blob.size, from + indexer.wanted);
		const bytes = new Uint8Array(await blob.slice(from, to).arrayBuffer());
		if (bytes.byteLength !== to - from) {
			throw new Error("Recording bytes could not be read for its index");
		}
		const before = indexer.position;
		indexer.push(bytes);
		guard = indexer.position === before ? guard + 1 : 0;
		if (guard > 1) throw new Error("Recording index made no progress");
	}
}
