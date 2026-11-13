import type {
	DeveloperVideoProcessingState,
	DeveloperVideoRendition,
	DeveloperVideoSlice,
	DeveloperVideoSlicedHls,
	DeveloperVideoSliceRendition,
	DeveloperVideoSliceResult,
} from "@cap/database/types";
import {
	HLS_AUDIO_BITRATE,
	HLS_SEGMENT_SECONDS,
	type HlsMasterVariant,
	type HlsSliceRange,
	hlsVariantCodecs,
	planHlsLadderSlices,
} from "./developer-video-sliced-playlist";

// This file is imported by the processing state, which the workflow bundles,
// so it must not import anything that needs a Node module.

// Every number that decides which videos are encoded in slices, and how.
//
// A ladder job spends about five seconds before its first frame (download,
// probe, encoder start) and then encodes at roughly 6 to 15 times real time.
// Under two minutes the whole ladder is done in 13 to 25 seconds, so slicing
// would save a few seconds for three or four times the jobs. From two minutes
// up, the first slice makes the video playable after the fixed cost plus two
// or three seconds, and the rest is shared between the workers.
export const SLICED_HLS = {
	minDurationSeconds: 120,
	// Short enough to encode in two or three seconds.
	firstSliceSeconds: 20,
	// A viewer who presses play the moment the first slice is in must not catch
	// up with the encode. At six times real time a slice up to six times as
	// long as everything before it is finished before that viewer reaches it,
	// so slices grow by this factor until the remaining thirds fit under it.
	rampFactor: 6,
	tailWorkers: 3,
	tailMinSliceSeconds: 60,
	// One upload may not hold more encoder slots than this at a time.
	maxInFlight: 3,
	// The seconds of video a slice holds may differ from its range by a frame
	// or two at either end. More than this and its neighbours would not meet.
	lengthToleranceSeconds: 0.5,
} as const;

function wholeSegments(seconds: number): number {
	return Math.floor(seconds / HLS_SEGMENT_SECONDS) * HLS_SEGMENT_SECONDS;
}

// Null means the video keeps the single ladder job it has always had.
export function planDeveloperVideoSlices(
	durationSeconds: number | null,
): HlsSliceRange[] | null {
	if (
		durationSeconds === null ||
		!Number.isFinite(durationSeconds) ||
		durationSeconds < SLICED_HLS.minDurationSeconds
	) {
		return null;
	}
	const ranges: HlsSliceRange[] = [
		{ startSeconds: 0, durationSeconds: SLICED_HLS.firstSliceSeconds },
	];
	let covered: number = SLICED_HLS.firstSliceSeconds;
	for (;;) {
		const ramp = wholeSegments(covered * SLICED_HLS.rampFactor);
		if ((durationSeconds - covered) / SLICED_HLS.tailWorkers <= ramp) break;
		ranges.push({ startSeconds: covered, durationSeconds: ramp });
		covered += ramp;
	}
	const tail = planHlsLadderSlices(
		durationSeconds - covered,
		SLICED_HLS.tailWorkers,
		SLICED_HLS.tailMinSliceSeconds,
	);
	for (const range of tail) {
		ranges.push({
			startSeconds: covered + range.startSeconds,
			...(range.durationSeconds === undefined
				? {}
				: { durationSeconds: range.durationSeconds }),
		});
	}
	return ranges;
}

export function createSlicedHls(
	ranges: HlsSliceRange[],
	output: string,
): DeveloperVideoSlicedHls {
	return {
		state: "encoding",
		output,
		exposed: null,
		hasAudio: false,
		slices: ranges.map((range) => ({
			startSeconds: range.startSeconds,
			durationSeconds: range.durationSeconds ?? null,
			job: { state: "pending" },
			attempts: 0,
			lostJobs: 0,
		})),
	};
}

// Every slice uploads into one folder. The slice and the attempt are part of
// each file name, so a second attempt at a slice never writes over the first,
// and the finished ladder is one folder of playlists and media like any other.
export function slicedFileName(
	file: string,
	slice: number,
	token: string,
): string {
	const dot = file.lastIndexOf(".");
	return `${file.slice(0, dot)}-${slice}-${token}${file.slice(dot)}`;
}

export type FinishedSlice = DeveloperVideoSlice & {
	job: { state: "complete"; output: string };
	result: DeveloperVideoSliceResult;
};

export function sliceIsFinished(
	slice: DeveloperVideoSlice | undefined,
): slice is FinishedSlice {
	return slice?.job.state === "complete" && slice.result !== undefined;
}

export function finishedSlices(
	sliced: DeveloperVideoSlicedHls,
): { index: number; slice: FinishedSlice }[] {
	return sliced.slices.flatMap((slice, index) =>
		sliceIsFinished(slice) ? [{ index, slice }] : [],
	);
}

// The slices a viewer can be given: finished ones from the start of the video
// with no hole between them.
export function playableSlices(
	sliced: DeveloperVideoSlicedHls,
): FinishedSlice[] {
	const playable: FinishedSlice[] = [];
	for (const slice of sliced.slices) {
		if (!sliceIsFinished(slice)) break;
		playable.push(slice);
	}
	return playable;
}

export function slicesMatch(
	expected: DeveloperVideoSliceRendition[],
	found: DeveloperVideoSliceRendition[],
): boolean {
	return (
		expected.length === found.length &&
		expected.every((rendition, index) => {
			const other = found[index];
			return (
				other !== undefined &&
				other.name === rendition.name &&
				other.width === rendition.width &&
				other.height === rendition.height
			);
		})
	);
}

export interface SlicedHlsPlayback {
	output: string;
	slices: FinishedSlice[];
	hasAudio: boolean;
	// Every slice is in, so the playlists carry their end marker.
	ended: boolean;
}

// Adaptive streaming served from slices while the ladder is not whole yet:
// either more slices are on their way, or a slice could not be made and the
// video is being encoded as one job, in which case the finished slices keep
// playing until that job has an answer.
export function slicedHlsPlayback(
	state: DeveloperVideoProcessingState,
): SlicedHlsPlayback | null {
	const { sliced, hls } = state;
	if (!sliced || sliced.exposed !== true || hls.state === "complete") {
		return null;
	}
	const waitingForWholeJob =
		sliced.state === "abandoned" &&
		(hls.state === "pending" || hls.state === "running");
	if (sliced.state !== "encoding" && !waitingForWholeJob) return null;
	const slices = playableSlices(sliced);
	if (slices.length === 0) return null;
	return {
		output: sliced.output,
		slices,
		hasAudio: sliced.hasAudio,
		ended:
			sliced.state === "encoding" && slices.length === sliced.slices.length,
	};
}

interface MergedRendition extends HlsMasterVariant {
	bytes: number;
}

function mergeSliceRenditions(slices: FinishedSlice[]): MergedRendition[] {
	const [first] = slices;
	if (!first) return [];
	return first.result.renditions.map((rendition, index) => {
		let bytes = 0;
		let seconds = 0;
		let weighted = 0;
		let peak = 0;
		for (const slice of slices) {
			const part = slice.result.renditions[index];
			if (!part) continue;
			bytes += part.bytes;
			seconds += slice.result.seconds;
			weighted += part.averageBandwidth * slice.result.seconds;
			peak = Math.max(peak, part.bandwidth);
		}
		return {
			name: rendition.name,
			width: rendition.width,
			height: rendition.height,
			bandwidth: peak,
			averageBandwidth: seconds > 0 ? Math.round(weighted / seconds) : peak,
			codecs: rendition.codecs,
			bytes,
		};
	});
}

export function slicedHlsMasterVariants(
	slices: FinishedSlice[],
): HlsMasterVariant[] {
	return mergeSliceRenditions(slices).map(({ bytes: _bytes, ...variant }) => ({
		...variant,
	}));
}

// The same figures a single ladder job reports for its renditions: bitrate is
// the average including audio, bytes are the rendition's media, and the codec
// list names the audio that plays with it.
export function slicedHlsRenditions(
	sliced: DeveloperVideoSlicedHls,
): DeveloperVideoRendition[] {
	const audio = sliced.hasAudio ? HLS_AUDIO_BITRATE : 0;
	return mergeSliceRenditions(
		finishedSlices(sliced).map(({ slice }) => slice),
	).map((rendition) => ({
		name: rendition.name,
		width: rendition.width,
		height: rendition.height,
		bitrate: rendition.averageBandwidth + audio,
		bytes: rendition.bytes,
		codecs: hlsVariantCodecs(rendition.codecs, sliced.hasAudio),
	}));
}

// Media stored by the finished slices, each file counted once: the audio for
// the whole video belongs to the first slice only.
export function slicedHlsBytes(sliced: DeveloperVideoSlicedHls): number {
	return finishedSlices(sliced).reduce(
		(total, { slice }) =>
			total +
			slice.result.audioBytes +
			slice.result.renditions.reduce(
				(sum, rendition) => sum + rendition.bytes,
				0,
			),
		0,
	);
}
