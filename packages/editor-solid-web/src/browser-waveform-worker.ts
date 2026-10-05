import {
	ALL_FORMATS,
	AudioSample,
	AudioSampleSink,
	CustomSource,
	EncodedPacketSink,
	Input,
	type InputAudioTrack,
	ReadableStreamSource,
	type Source,
} from "mediabunny";
import { type ByteRange, sparseAudioPlan } from "./mp4-audio-ranges";

type WaveformRequest = { url: string } | { grant: number; bytes: number };
type WaveformResponse =
	| { peaks: number[] }
	| { error: string }
	| { gate: number };

const scope = self as unknown as {
	addEventListener: (
		type: "message",
		listener: (event: MessageEvent<WaveformRequest>) => void,
	) => void;
	postMessage: (message: WaveformResponse) => void;
};

const grants = new Map<number, (bytes: number) => void>();
let nextGate = 0;

/// Waits until the editor's own media reads leave the connection idle, and
/// returns how much one read may take before handing it back.
function gate() {
	const id = nextGate++;
	return new Promise<number>((resolve) => {
		grants.set(id, resolve);
		scope.postMessage({ gate: id });
	});
}

/// The file in order as ranged reads, each one waiting for the connection.
/// Null when the storage ignores ranges.
async function gatedStream(url: string) {
	let position = 0;
	let size: number | null = null;
	const first = await gate();
	const opening = await fetchRange(url, 0, first, false).catch(() => null);
	if (!opening) return null;
	size = opening.size;
	position = opening.bytes.byteLength;
	let pending: Uint8Array | null = opening.bytes;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (pending) {
				controller.enqueue(pending);
				pending = null;
				return;
			}
			if (size === null || position >= size) {
				controller.close();
				return;
			}
			const bytes = await gate();
			const read = await fetchRange(
				url,
				position,
				Math.min(size, position + bytes),
				false,
			);
			position += read.bytes.byteLength;
			controller.enqueue(read.bytes);
		},
	});
}

/// Hands every decoded sample of the track to `onSample`, in order, as
/// mediabunny's `AudioSampleSink` would. Its sample iterator trims a one
/// second window of packet times with `Array.shift` on every packet, which is
/// quadratic at the tens of thousands of packets a second a long recording
/// decodes at: most of the worker's time for two hours of audio. False when
/// the track needs one of mediabunny's own decoders.
async function decodeEach(
	track: InputAudioTrack,
	onSample: (sample: AudioSample) => void,
) {
	if (typeof AudioDecoder !== "function" || track.codec?.startsWith("pcm")) {
		return false;
	}
	const config = await track.getDecoderConfig();
	if (!config || !(await AudioDecoder.isConfigSupported(config)).supported) {
		return false;
	}
	let failure: unknown = null;
	const decoder = new AudioDecoder({
		output: (data) => {
			const sample = new AudioSample(data);
			if (failure || sample.numberOfFrames === 0) {
				sample.close();
				return;
			}
			try {
				onSample(sample);
			} catch (cause) {
				failure = cause;
			}
		},
		error: (cause) => {
			failure ??= cause;
		},
	});
	try {
		decoder.configure(config);
		const packets = new EncodedPacketSink(track);
		const options = { verifyKeyPackets: true };
		for (
			let packet = await packets.getFirstPacket(options);
			packet;
			packet = await packets.getNextPacket(packet, options)
		) {
			if (failure) throw failure;
			decoder.decode(packet.toEncodedAudioChunk());
			if (decoder.decodeQueueSize <= 32) continue;
			// Polls too: an error closes the decoder without a dequeue event.
			while (decoder.decodeQueueSize > 8 && !failure) {
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, 5);
					decoder.addEventListener(
						"dequeue",
						() => {
							clearTimeout(timer);
							resolve();
						},
						{ once: true },
					);
				});
			}
		}
		await decoder.flush();
		if (failure) throw failure;
		return true;
	} finally {
		if (decoder.state !== "closed") decoder.close();
	}
}

/// Mean absolute level in dB for every tenth of a second of the track,
/// decoded off the main thread so long recordings don't stall the editor.
/// The file streams through once: ranged reads ahead of a decoder this slow
/// get dropped and fetched again, several times the file for long audio.
/// Every read waits for the preview's media reads, which come first.
async function waveform(url: string) {
	const ranged = await rangedAudioSource(url).catch(() => null);
	if (ranged) {
		try {
			return await peaksFrom(ranged);
		} catch {}
	}
	const stream = await gatedStream(url);
	if (stream) return peaksFrom(new ReadableStreamSource(stream));
	await gate();
	const response = await fetch(url, { priority: "low", cache: "no-store" });
	if (!response.ok || !response.body) {
		throw new Error("Editor waveform audio could not load");
	}
	return peaksFrom(new ReadableStreamSource(response.body));
}

async function peaksFrom(source: Source) {
	const input = new Input({ formats: ALL_FORMATS, source });
	try {
		const track = await input.getPrimaryAudioTrack();
		if (!track) return [];
		const sampleRate = await track.getSampleRate();
		const channels = await track.getNumberOfChannels();
		if (!sampleRate || !channels) return [];
		const blockSamples = Math.max(1, Math.floor(sampleRate / 10) * channels);
		const peaks: number[] = [];
		let plane = new Float32Array(0);
		let sums = new Float64Array(0);
		let sum = 0;
		let count = 0;
		const add = (sample: AudioSample) => {
			const frames = sample.numberOfFrames;
			if (plane.length < frames) {
				plane = new Float32Array(frames);
				sums = new Float64Array(frames);
			} else {
				sums.fill(0, 0, frames);
			}
			for (let channel = 0; channel < sample.numberOfChannels; channel++) {
				sample.copyTo(plane, { planeIndex: channel, format: "f32-planar" });
				for (let frame = 0; frame < frames; frame++) {
					sums[frame] = (sums[frame] ?? 0) + Math.abs(plane[frame] ?? 0);
				}
			}
			sample.close();
			for (let frame = 0; frame < frames; frame++) {
				sum += sums[frame] ?? 0;
				count += channels;
				if (count >= blockSamples) {
					const mean = sum / count;
					peaks.push(mean > 0 ? 20 * Math.log10(mean) : -60);
					sum = 0;
					count = 0;
				}
			}
		};
		if (!(await decodeEach(track, add))) {
			for await (const sample of new AudioSampleSink(track).samples()) {
				add(sample);
			}
		}
		if (count > 0) {
			const mean = sum / count;
			peaks.push(mean > 0 ? 20 * Math.log10(mean) : -60);
		}
		return peaks;
	} finally {
		input.dispose();
	}
}

const HEAD_BYTES = 64 * 1024;
const MAX_MOOV_BYTES = 64 * 1024 * 1024;
const MAX_TOP_LEVEL_BOXES = 64;
const IN_FLIGHT = 6;
const WINDOW_BYTES = 4 * 1024 * 1024;

function copyOverlap(
	out: Uint8Array,
	outStart: number,
	start: number,
	bytes: Uint8Array,
) {
	const from = Math.max(outStart, start);
	const to = Math.min(outStart + out.byteLength, start + bytes.byteLength);
	if (from < to)
		out.set(bytes.subarray(from - start, to - start), from - outStart);
}

function windows(range: ByteRange, bytes: number) {
	const out: ByteRange[] = [];
	for (let start = range.start; start < range.end; start += bytes)
		out.push({ start, end: Math.min(range.end, start + bytes) });
	return out;
}

async function fetchRange(
	url: string,
	start: number,
	end: number,
	gated = true,
) {
	if (gated) await gate();
	const response = await fetch(url, {
		headers: { Range: `bytes=${start}-${end - 1}` },
		priority: "low",
		cache: "no-store",
	});
	if (response.status !== 206)
		throw new Error("Editor waveform audio needs ranged reads");
	const size = Number(
		/\/(\d+)$/.exec(response.headers.get("Content-Range") ?? "")?.[1],
	);
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength !== Math.min(end, size) - start)
		throw new Error("Editor waveform audio read was short");
	return { bytes, size };
}

/// A ranged source for an MP4: only its audio chunks when the audio sits in
/// large enough runs between the video, or its media in order when the index
/// comes after it, which a stream can't go back for. Null leaves the file to
/// the plain stream: most muxers interleave a little audio per video frame,
/// so reading around the video costs more than reading it.
async function rangedAudioSource(url: string): Promise<Source | null> {
	const head = await fetchRange(url, 0, HEAD_BYTES);
	const size = head.size;
	if (!Number.isSafeInteger(size) || size <= head.bytes.byteLength) return null;
	const headerAt = async (offset: number) =>
		offset + 16 <= head.bytes.byteLength
			? head.bytes.subarray(offset, offset + 16)
			: (await fetchRange(url, offset, Math.min(size, offset + 16))).bytes;
	let offset = 0;
	let moov: { start: number; bytes: Uint8Array } | null = null;
	let mdat: ByteRange | null = null;
	for (
		let count = 0;
		offset + 8 <= size && count < MAX_TOP_LEVEL_BOXES;
		count++
	) {
		const header = await headerAt(offset);
		const view = new DataView(
			header.buffer,
			header.byteOffset,
			header.byteLength,
		);
		let boxSize = view.getUint32(0);
		if (boxSize === 1 && header.byteLength >= 16)
			boxSize = Number(view.getBigUint64(8));
		else if (boxSize === 0) boxSize = size - offset;
		const type = String.fromCharCode(...header.subarray(4, 8));
		if (boxSize < 8 || type === "moof" || (offset === 0 && type !== "ftyp"))
			return null;
		if (type === "mdat" && !mdat)
			mdat = { start: offset, end: Math.min(size, offset + boxSize) };
		if (type === "moov") {
			if (boxSize > MAX_MOOV_BYTES) return null;
			moov = {
				start: offset,
				bytes:
					offset + boxSize <= head.bytes.byteLength
						? head.bytes.subarray(offset, offset + boxSize)
						: (await fetchRange(url, offset, offset + boxSize)).bytes,
			};
			break;
		}
		offset += boxSize;
	}
	if (!moov) return null;
	const plan =
		sparseAudioPlan(moov.bytes, size) ??
		(mdat && mdat.start < moov.start ? windows(mdat, WINDOW_BYTES) : null);
	if (!plan) return null;
	const known = [
		{ start: 0, bytes: head.bytes },
		{ start: moov.start, bytes: moov.bytes },
	];
	const groups = plan.map((range) => ({
		...range,
		bytes: null as Promise<Uint8Array> | null,
	}));
	let next = 0;
	const load = (index: number) => {
		const group = groups[index];
		if (!group) return;
		group.bytes ??= fetchRange(url, group.start, group.end).then(
			(read) => read.bytes,
		);
	};
	return new CustomSource({
		getSize: () => size,
		prefetchProfile: "none",
		read: async (start, end) => {
			for (const piece of known) {
				if (start >= piece.start && end <= piece.start + piece.bytes.byteLength)
					return piece.bytes.slice(start - piece.start, end - piece.start);
			}
			let first = 0;
			let last = groups.length;
			while (first < last) {
				const mid = (first + last) >>> 1;
				if ((groups[mid]?.end ?? 0) <= start) first = mid + 1;
				else last = mid;
			}
			if ((groups[first]?.start ?? end) >= end)
				return (await fetchRange(url, start, end)).bytes;
			for (let index = next; index < first; index++) {
				const done = groups[index];
				if (done) done.bytes = null;
			}
			next = Math.max(next, first);
			// A read can run on from the previous one across the video between
			// two audio chunks. Only the audio packets in it are used, so the
			// bytes around them stay zero instead of being downloaded.
			const out = new Uint8Array(end - start);
			for (const piece of known)
				copyOverlap(out, start, piece.start, piece.bytes);
			for (let index = first; index < first + IN_FLIGHT; index++) load(index);
			for (
				let index = first;
				index < groups.length && (groups[index]?.start ?? end) < end;
				index++
			) {
				load(index);
				const group = groups[index];
				if (group?.bytes)
					copyOverlap(out, start, group.start, await group.bytes);
			}
			return out;
		},
	});
}

scope.addEventListener("message", (event) => {
	const message = event.data;
	if ("grant" in message) {
		const grant =
			typeof message.grant === "number" ? grants.get(message.grant) : undefined;
		if (typeof grant === "function") {
			grants.delete(message.grant);
			grant(message.bytes);
		}
		return;
	}
	void waveform(message.url).then(
		(peaks) => scope.postMessage({ peaks }),
		(error: unknown) =>
			scope.postMessage({
				error: error instanceof Error ? error.message : String(error),
			}),
	);
});
