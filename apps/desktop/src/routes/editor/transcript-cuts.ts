import { unwrap } from "solid-js/store";
import type {
	CaptionSegment,
	SegmentRecordings,
	TimelineSegment,
	TranscriptCut,
	TranscriptCutOverlay,
	TranscriptCutPiece,
	TranscriptCutTracks,
	TranscriptRange,
	TranscriptTrimmedWord,
} from "~/utils/tauri";
import {
	getCaptionTextFromWords,
	type MappedTimeRange,
	mapSourceRangeToEdited,
} from "./captions";
import { transitionsAfterClipMerge } from "./clip-merge";
import {
	type ClipTransition,
	clipDuration,
	clipTimelineDuration,
	clipTimelineOffsets,
	getClipTransition,
	rangeIntersectsClipTransition,
} from "./clip-transitions";
import type { EditorProjectConfiguration } from "./context";
import {
	isFillerWord,
	readsAsEnglish,
	spokenWordEnd,
} from "./filler-detection";
import {
	effectiveToOutput,
	effectiveToOutputEnd,
	holdWindows,
} from "./timeline-holds";
import { rippleDeleteAllTracks, rippleInsertAllTracks } from "./timeline-utils";
import { getSegmentTrack } from "./timelineTracks";
import type { FlatWord } from "./transcript-edits";

export const PAUSE_DETECTION_THRESHOLD = 0.5;
export const AUTO_CLEAN_SILENCE_THRESHOLD = 1.5;
export const MAX_CUT_PADDING = 1;

const RANGE_EPSILON = 1e-4;
const MIN_TIMELINE_CUT = 0.001;
const SNAPSHOT_EPSILON = 1e-6;
const WORD_TIME_EPSILON = 1e-3;

export type SourceRange = TranscriptRange;

type TranscriptProject = Pick<
	EditorProjectConfiguration,
	"captions" | "timeline"
>;
type TranscriptTimeline = NonNullable<TranscriptProject["timeline"]>;
type TranscriptCaptions = NonNullable<TranscriptProject["captions"]>;

export function mergeSourceRanges(
	ranges: readonly SourceRange[],
): SourceRange[] {
	const sorted = ranges
		.filter((range) => range.end - range.start > RANGE_EPSILON)
		.map((range) => ({ start: range.start, end: range.end }))
		.sort((a, b) => a.start - b.start);
	const merged: SourceRange[] = [];
	for (const range of sorted) {
		const last = merged[merged.length - 1];
		if (last && range.start <= last.end + RANGE_EPSILON) {
			last.end = Math.max(last.end, range.end);
		} else {
			merged.push(range);
		}
	}
	return merged;
}

export function subtractSourceRanges(
	from: readonly SourceRange[],
	remove: readonly SourceRange[],
): SourceRange[] {
	const removals = mergeSourceRanges(remove);
	const result: SourceRange[] = [];
	for (const range of mergeSourceRanges(from)) {
		let cursor = range.start;
		for (const removal of removals) {
			if (removal.end <= cursor) continue;
			if (removal.start >= range.end) break;
			if (removal.start > cursor) {
				result.push({ start: cursor, end: removal.start });
			}
			cursor = Math.max(cursor, removal.end);
			if (cursor >= range.end) break;
		}
		if (range.end > cursor) result.push({ start: cursor, end: range.end });
	}
	return result.filter((range) => range.end - range.start > RANGE_EPSILON);
}

export function intersectSourceRanges(
	a: readonly SourceRange[],
	b: readonly SourceRange[],
): SourceRange[] {
	const left = mergeSourceRanges(a);
	const right = mergeSourceRanges(b);
	const result: SourceRange[] = [];
	let i = 0;
	let j = 0;
	while (i < left.length && j < right.length) {
		const start = Math.max(left[i].start, right[j].start);
		const end = Math.min(left[i].end, right[j].end);
		if (end - start > RANGE_EPSILON) result.push({ start, end });
		if (left[i].end < right[j].end) i++;
		else j++;
	}
	return result;
}

export function sourceRangesDuration(ranges: readonly SourceRange[]) {
	return ranges.reduce((total, range) => total + (range.end - range.start), 0);
}

function recordingOffsets(recordingSegments: SegmentRecordings[]) {
	const offsets: number[] = [];
	let cumulative = 0;
	for (const recording of recordingSegments) {
		offsets.push(cumulative);
		cumulative += recording.display.duration;
	}
	return offsets;
}

export function timelineSourceCoverage(
	segments: readonly TimelineSegment[],
	recordingSegments: SegmentRecordings[],
): SourceRange[] {
	const offsets = recordingOffsets(recordingSegments);
	return mergeSourceRanges(
		segments.map((segment) => {
			const offset = offsets[segment.recordingSegment ?? 0] ?? 0;
			return { start: offset + segment.start, end: offset + segment.end };
		}),
	);
}

export function cutClaim(
	cut: Pick<TranscriptCut, "start" | "end" | "bufferStart" | "bufferEnd">,
): SourceRange | null {
	const start = Math.max(0, cut.start - (cut.bufferStart ?? 0));
	const end = cut.end + (cut.bufferEnd ?? 0);
	return end - start > RANGE_EPSILON ? { start, end } : null;
}

function cutClaims(cuts: readonly TranscriptCut[]) {
	return mergeSourceRanges(
		cuts.flatMap((cut) => {
			const claim = cutClaim(cut);
			return claim ? [claim] : [];
		}),
	);
}

export type PaddingRoom = { before: number; after: number };

export function cutPaddingLimits(
	cut: Pick<TranscriptCut, "start" | "end" | "bufferStart" | "bufferEnd">,
	room: PaddingRoom = { before: MAX_CUT_PADDING, after: MAX_CUT_PADDING },
) {
	const half = Math.floor(((cut.end - cut.start) / 2) * 100 + 1e-6) / 100;
	const shrink = (other: number | undefined) =>
		-Math.min(0.5, Math.max(0, half + Math.min(0, other ?? 0)));
	return {
		before: {
			min: shrink(cut.bufferEnd),
			max: Math.min(MAX_CUT_PADDING, room.before),
		},
		after: {
			min: shrink(cut.bufferStart),
			max: Math.min(MAX_CUT_PADDING, room.after),
		},
	};
}

function paddingRoom(
	cut: Pick<TranscriptCut, "start" | "end">,
	obstacles: readonly SourceRange[],
): PaddingRoom {
	let before = MAX_CUT_PADDING;
	let after = MAX_CUT_PADDING;
	for (const range of obstacles) {
		if (range.end <= cut.start + RANGE_EPSILON)
			before = Math.min(before, cut.start - range.end);
		else if (range.start >= cut.end - RANGE_EPSILON)
			after = Math.min(after, range.start - cut.end);
	}
	return { before: Math.max(0, before), after: Math.max(0, after) };
}

function transcriptSpeech(
	captions:
		| Pick<TranscriptCaptions, "segments" | "transcriptHidden">
		| null
		| undefined,
) {
	return mergeSourceRanges([
		...(captions?.transcriptHidden ?? []),
		...(captions?.segments ?? []).filter((segment) => !segment.words?.length),
	]);
}

export function cutPaddingRoom(
	captions:
		| Pick<TranscriptCaptions, "segments" | "transcriptHidden">
		| null
		| undefined,
	cut: Pick<TranscriptCut, "start" | "end">,
) {
	return paddingRoom(cut, [
		...transcriptSpeech(captions),
		...flattenCaptionWords(captions?.segments ?? []).map((word) => ({
			start: word.start,
			end: spokenWordEnd(word),
		})),
	]);
}

function clampCutPadding(cut: TranscriptCut, room: PaddingRoom): TranscriptCut {
	const clamp = (value: number, range: { min: number; max: number }) =>
		Math.min(range.max, Math.max(range.min, value));
	const bufferStart = clamp(
		cut.bufferStart ?? 0,
		cutPaddingLimits(cut, room).before,
	);
	const bufferEnd = clamp(
		cut.bufferEnd ?? 0,
		cutPaddingLimits({ ...cut, bufferStart }, room).after,
	);
	return { ...cut, bufferStart, bufferEnd };
}

function cutConflictsWithTransition(
	segments: TimelineSegment[],
	transitions: ClipTransition[],
	offsets: number[],
	range: MappedTimeRange,
) {
	if (
		rangeIntersectsClipTransition(segments, transitions, range.start, range.end)
	)
		return true;
	const incoming =
		getClipTransition(segments, transitions, range.segmentIndex)?.duration ?? 0;
	const outgoing =
		getClipTransition(segments, transitions, range.segmentIndex + 1)
			?.duration ?? 0;
	if (incoming === 0 && outgoing === 0) return false;
	const localStart = range.start - offsets[range.segmentIndex];
	const localEnd = range.end - offsets[range.segmentIndex];
	const duration = clipDuration(segments[range.segmentIndex]);
	return (
		localStart + RANGE_EPSILON < incoming * 2 ||
		duration - localEnd + RANGE_EPSILON < outgoing * 2
	);
}

function editedRangesForSource(
	timeline: TranscriptTimeline,
	ranges: readonly SourceRange[],
	recordingSegments: SegmentRecordings[],
	offsets: number[],
) {
	const transitions = timeline.transitions ?? [];
	const outputRanges = mergeSourceRanges(ranges)
		.flatMap((range) =>
			mapSourceRangeToEdited(
				range.start,
				range.end,
				timeline.segments,
				recordingSegments,
				transitions,
			),
		)
		.map((range) => {
			const clipStart = offsets[range.segmentIndex];
			const clipEnd =
				clipStart + clipDuration(timeline.segments[range.segmentIndex]);
			return {
				...range,
				start: Math.max(range.start, clipStart),
				end: Math.min(range.end, clipEnd),
			};
		})
		.filter((range) => range.end - range.start > MIN_TIMELINE_CUT)
		.sort((a, b) => a.start - b.start || a.segmentIndex - b.segmentIndex);

	const merged: MappedTimeRange[] = [];
	for (const range of outputRanges) {
		const last = merged[merged.length - 1];
		if (
			last &&
			last.segmentIndex === range.segmentIndex &&
			range.start <= last.end + RANGE_EPSILON
		) {
			last.end = Math.max(last.end, range.end);
		} else {
			merged.push({ ...range });
		}
	}
	return merged;
}

export function sourceRangeBlockedByTransition(
	timeline: TranscriptTimeline,
	range: SourceRange,
	recordingSegments: SegmentRecordings[],
) {
	const transitions = timeline.transitions ?? [];
	if (transitions.length === 0) return false;
	const offsets = clipTimelineOffsets(timeline.segments, transitions);
	return editedRangesForSource(
		timeline,
		[range],
		recordingSegments,
		offsets,
	).some((edited) =>
		cutConflictsWithTransition(timeline.segments, transitions, offsets, edited),
	);
}

const OVERLAY_TRACKS = [
	"zoomSegments",
	"sceneSegments",
	"maskSegments",
	"textSegments",
	"keyboardSegments",
	"audioSegments",
	"styleSegments",
	"imageSegments",
	"camera3dSegments",
] as const satisfies readonly (keyof TranscriptCutTracks)[];

type OverlayTrack = (typeof OVERLAY_TRACKS)[number];
type OverlaySegment = { start: number; end: number; track?: number };
type OverlayTracks = { [K in OverlayTrack]?: OverlaySegment[] | null };
type OverlayChanges = {
	[K in OverlayTrack]?: TranscriptCutOverlay<OverlaySegment>[];
};
type TouchedOverlays = Array<{
	key: OverlayTrack;
	segments: Array<{ raw: OverlaySegment; before: OverlaySegment }>;
}>;

function sameValue(a: unknown, b: unknown): boolean {
	if (typeof a === "number" && typeof b === "number")
		return Math.abs(a - b) <= SNAPSHOT_EPSILON;
	if (a === null || a === undefined || b === null || b === undefined)
		return (a ?? null) === (b ?? null);
	if (typeof a !== "object" || typeof b !== "object") return a === b;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const left = a as Record<string, unknown>;
	const right = b as Record<string, unknown>;
	for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
		if (!sameValue(left[key], right[key])) return false;
	}
	return true;
}

function shiftOverlay<T extends OverlaySegment>(segment: T, by: number): T {
	return { ...segment, start: segment.start + by, end: segment.end + by };
}

function touchOverlays(
	tracks: OverlayTracks,
	start: number,
	end: number,
): TouchedOverlays {
	return OVERLAY_TRACKS.map((key) => ({
		key,
		segments: (tracks[key] ?? []).flatMap((segment) => {
			if (segment.end <= start || segment.start >= end) return [];
			const raw = unwrap(segment);
			return [{ raw, before: structuredClone(raw) }];
		}),
	}));
}

function overlayChanges(
	tracks: OverlayTracks,
	touched: TouchedOverlays,
	origin: number,
) {
	const changes: OverlayChanges = {};
	for (const { key, segments } of touched) {
		const remaining = new Set(
			(tracks[key] ?? []).map((segment) => unwrap(segment)),
		);
		const entries = segments.flatMap(({ raw, before }) => {
			const original = shiftOverlay(before, -origin);
			if (!remaining.has(raw)) return [{ before: original }];
			const after = structuredClone(raw);
			return sameValue(before, after)
				? []
				: [{ before: original, after: shiftOverlay(after, -origin) }];
		});
		if (entries.length > 0) changes[key] = entries;
	}
	return changes as TranscriptCutTracks;
}

function takeOverlays(
	tracks: OverlayTracks,
	overlays: TranscriptCutTracks | null | undefined,
	origin: number,
) {
	const changes: OverlayChanges = overlays ?? {};
	return OVERLAY_TRACKS.flatMap((key) =>
		(changes[key] ?? []).flatMap((entry) => {
			const after = entry.after;
			if (after) {
				const track = tracks[key] ?? [];
				const index = track.findIndex((segment) =>
					sameValue(shiftOverlay(unwrap(segment), -origin), after),
				);
				if (index === -1) return [];
				track.splice(index, 1);
			}
			return [
				{
					key,
					segment: shiftOverlay(structuredClone(unwrap(entry.before)), origin),
				},
			];
		}),
	);
}

function putBackOverlays(
	tracks: OverlayTracks,
	restored: ReturnType<typeof takeOverlays>,
) {
	for (const { key, segment } of restored) {
		if (!tracks[key]) tracks[key] = [];
		const track = tracks[key] ?? [];
		const index = track.findIndex(
			(other) =>
				(getSegmentTrack(other) - getSegmentTrack(segment) ||
					other.start - segment.start) > 0,
		);
		track.splice(index === -1 ? track.length : index, 0, segment);
	}
}

function removeTimelineRange(
	timeline: TranscriptTimeline,
	range: MappedTimeRange,
	sequence: number,
): TranscriptCutPiece | null {
	const clip = timeline.segments[range.segmentIndex];
	if (!clip) return null;
	const transitions = timeline.transitions ?? [];
	const clipStart = clipTimelineOffsets(timeline.segments, transitions)[
		range.segmentIndex
	];
	const start = Math.max(range.start, clipStart);
	const end = Math.min(range.end, clipStart + clipDuration(clip));
	const holds = holdWindows(timeline.textSegments);
	const overlayStart = effectiveToOutput(holds, start);
	const overlayEnd = effectiveToOutputEnd(holds, end);
	const touched = touchOverlays(timeline, overlayStart, overlayEnd);
	const original = { ...unwrap(clip) };
	const durationBefore = clipTimelineDuration(timeline.segments, transitions);

	rippleDeleteAllTracks(timeline, start, end, range.segmentIndex);
	if (
		clipTimelineDuration(timeline.segments, timeline.transitions ?? []) >=
		durationBefore
	)
		return null;

	const held = overlayEnd - overlayStart - (end - start);
	return {
		sequence,
		clip: original,
		start: original.start + (start - clipStart) * original.timescale,
		end: original.start + (end - clipStart) * original.timescale,
		held: held > RANGE_EPSILON ? held : 0,
		overlays: overlayChanges(timeline, touched, overlayStart),
	};
}

type OwnedRanges = { owner: number; ranges: SourceRange[] };

function claimOwners(
	cuts: readonly TranscriptCut[],
	ranges: readonly SourceRange[],
): OwnedRanges[] {
	let unowned = mergeSourceRanges(ranges);
	const owned: OwnedRanges[] = [];
	cuts.forEach((cut, owner) => {
		const claim = cutClaim(cut);
		if (!claim || unowned.length === 0) return;
		const mine = intersectSourceRanges(unowned, [claim]);
		if (mine.length === 0) return;
		owned.push({ owner, ranges: mine });
		unowned = subtractSourceRanges(unowned, mine);
	});
	return owned;
}

function cutTimelineSourceRanges(
	timeline: TranscriptTimeline,
	owned: readonly OwnedRanges[],
	recordingSegments: SegmentRecordings[],
	sequence: number,
): "transition" | Array<{ owner: number; piece: TranscriptCutPiece }> {
	const transitions = timeline.transitions ?? [];
	const offsets = clipTimelineOffsets(timeline.segments, transitions);
	const removals = owned.flatMap(({ owner, ranges }) =>
		editedRangesForSource(timeline, ranges, recordingSegments, offsets).map(
			(range) => ({ owner, range }),
		),
	);

	if (
		removals.some(({ range }) =>
			cutConflictsWithTransition(
				timeline.segments,
				transitions,
				offsets,
				range,
			),
		)
	)
		return "transition";

	const pieces: Array<{ owner: number; piece: TranscriptCutPiece }> = [];
	for (const { owner, range } of removals.sort(
		(a, b) => b.range.start - a.range.start,
	)) {
		const piece = removeTimelineRange(
			timeline,
			range,
			sequence + pieces.length,
		);
		if (piece) pieces.push({ owner, piece });
	}
	return pieces;
}

const CLIP_JOIN_EPSILON = 1e-4;

function clipSettingsMatch(left: TimelineSegment, right: TimelineSegment) {
	const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
	keys.delete("start");
	keys.delete("end");
	for (const key of keys) {
		const a = left[key as keyof TimelineSegment] ?? null;
		const b = right[key as keyof TimelineSegment] ?? null;
		if (a !== b) return false;
	}
	return true;
}

function insertRecordingRange(
	timeline: TranscriptTimeline,
	recording: number,
	start: number,
	end: number,
	piece?: TranscriptCutPiece,
): "applied" | "transition" {
	const segments = timeline.segments;
	const transitions = timeline.transitions ?? [];
	const offsets = clipTimelineOffsets(segments, transitions);
	const durationBefore = clipTimelineDuration(segments, transitions);
	const fromRecording = (index: number) =>
		(segments[index]?.recordingSegment ?? 0) === recording;
	const blocked = (boundaryIndex: number) =>
		boundaryIndex > 0 &&
		boundaryIndex < segments.length &&
		getClipTransition(segments, transitions, boundaryIndex) !== null;
	const continuesBefore =
		piece !== undefined && piece.clip.start < start - CLIP_JOIN_EPSILON;
	const continuesAfter =
		piece !== undefined && piece.clip.end > end + CLIP_JOIN_EPSILON;
	const joins = (segment: TimelineSegment, continues: boolean) =>
		!piece || continues || clipSettingsMatch(segment, piece.clip);

	const previous: number[] = [];
	const next: number[] = [];
	segments.forEach((segment, index) => {
		if (!fromRecording(index)) return;
		if (
			Math.abs(segment.end - start) <= CLIP_JOIN_EPSILON &&
			joins(segment, continuesBefore)
		)
			previous.push(index);
		if (
			Math.abs(segment.start - end) <= CLIP_JOIN_EPSILON &&
			joins(segment, continuesAfter)
		)
			next.push(index);
	});
	const joinIndex = previous.find((index) => next.includes(index + 1));

	let boundary: number;
	if (joinIndex !== undefined) {
		if (blocked(joinIndex + 1)) return "transition";
		const left = segments[joinIndex];
		const right = segments[joinIndex + 1];
		boundary = offsets[joinIndex] + clipDuration(left);
		if (clipSettingsMatch(left, right)) {
			left.end = right.end;
			segments.splice(joinIndex + 1, 1);
			timeline.transitions = transitionsAfterClipMerge(transitions, joinIndex);
		} else {
			left.end = end;
		}
	} else if (previous.length > 0) {
		const index = previous[0];
		if (blocked(index + 1)) return "transition";
		boundary = offsets[index] + clipDuration(segments[index]);
		segments[index].end = end;
	} else if (next.length > 0) {
		const index = next[0];
		if (blocked(index)) return "transition";
		boundary = offsets[index];
		segments[index].start = start;
	} else {
		let anchor = -1;
		let insertAt = segments.length;
		segments.forEach((segment, index) => {
			if (!fromRecording(index) || segment.end > start + CLIP_JOIN_EPSILON)
				return;
			if (anchor === -1 || segment.end >= segments[anchor].end) {
				anchor = index;
				insertAt = index + 1;
			}
		});
		if (anchor === -1) {
			segments.forEach((segment, index) => {
				if (!fromRecording(index) || segment.start < end - CLIP_JOIN_EPSILON)
					return;
				if (anchor === -1 || segment.start < segments[anchor].start) {
					anchor = index;
					insertAt = index;
				}
			});
		}
		if (anchor === -1) {
			let before = -1;
			let after = -1;
			segments.forEach((segment, index) => {
				const segmentRecording = segment.recordingSegment ?? 0;
				if (segmentRecording < recording) before = index;
				else if (segmentRecording > recording && after === -1) after = index;
			});
			anchor = before !== -1 ? before : after;
			insertAt = before !== -1 ? before + 1 : after !== -1 ? after : 0;
		}
		if (blocked(insertAt)) return "transition";
		boundary = insertAt < segments.length ? offsets[insertAt] : durationBefore;
		const template = piece?.clip ?? segments[anchor];
		segments.splice(insertAt, 0, {
			...template,
			timescale: template?.timescale ?? 1,
			recordingSegment: recording,
			start,
			end,
			name: piece?.clip.name ?? null,
		});
		timeline.transitions = transitions.map((transition) =>
			transition.segmentIndex >= insertAt
				? { ...transition, segmentIndex: transition.segmentIndex + 1 }
				: transition,
		);
	}

	const shift =
		clipTimelineDuration(timeline.segments, timeline.transitions ?? []) -
		durationBefore;
	const overlayBoundary = effectiveToOutput(
		holdWindows(timeline.textSegments),
		boundary,
	);
	const restored = piece
		? takeOverlays(timeline, piece.overlays, overlayBoundary)
		: [];
	rippleInsertAllTracks(timeline, overlayBoundary, shift + (piece?.held ?? 0));
	putBackOverlays(timeline, restored);
	return "applied";
}

function pieceSourceRange(
	piece: TranscriptCutPiece,
	offsets: readonly number[],
): SourceRange | null {
	const offset = offsets[piece.clip.recordingSegment ?? 0];
	return offset === undefined
		? null
		: { start: offset + piece.start, end: offset + piece.end };
}

function restoreTimelineSourceRanges(
	timeline: TranscriptTimeline,
	ranges: readonly SourceRange[],
	recordingSegments: SegmentRecordings[],
	pieces: readonly TranscriptCutPiece[],
): "applied" | "transition" {
	const offsets = recordingOffsets(recordingSegments);
	for (const piece of [...pieces].sort((a, b) => b.sequence - a.sequence)) {
		const source = pieceSourceRange(piece, offsets);
		if (!source) continue;
		const restorable = subtractSourceRanges(
			ranges,
			timelineSourceCoverage(timeline.segments, recordingSegments),
		);
		if (
			sourceRangesDuration(subtractSourceRanges([source], restorable)) >
			RANGE_EPSILON
		)
			continue;
		if (
			insertRecordingRange(
				timeline,
				piece.clip.recordingSegment ?? 0,
				piece.start,
				piece.end,
				piece,
			) === "transition"
		)
			return "transition";
	}
	for (const range of mergeSourceRanges(ranges)) {
		for (let recording = 0; recording < recordingSegments.length; recording++) {
			const offset = offsets[recording];
			const local = {
				start: Math.max(range.start, offset) - offset,
				end:
					Math.min(
						range.end,
						offset + recordingSegments[recording].display.duration,
					) - offset,
			};
			if (local.end - local.start <= RANGE_EPSILON) continue;
			const covered = timeline.segments
				.filter((segment) => (segment.recordingSegment ?? 0) === recording)
				.map((segment) => ({ start: segment.start, end: segment.end }));
			for (const gap of subtractSourceRanges([local], covered)) {
				if (
					insertRecordingRange(timeline, recording, gap.start, gap.end) ===
					"transition"
				)
					return "transition";
			}
		}
	}
	return "applied";
}

function syncSegmentFromWords(segment: CaptionSegment) {
	const words = segment.words ?? [];
	if (words.length === 0) return;
	segment.text = getCaptionTextFromWords(words);
	segment.start = words[0].start;
	segment.end = words[words.length - 1].end;
}

export function removeCaptionWords(
	captions: Pick<TranscriptCaptions, "segments">,
	words: readonly FlatWord[],
) {
	const sorted = [...words].sort(
		(a, b) => b.segmentIndex - a.segmentIndex || b.wordIndex - a.wordIndex,
	);
	for (const word of sorted) {
		const segment = captions.segments[word.segmentIndex];
		if (!segment?.words) continue;
		if (word.wordIndex >= 0 && word.wordIndex < segment.words.length) {
			segment.words.splice(word.wordIndex, 1);
		}
	}
	for (const index of [...new Set(sorted.map((word) => word.segmentIndex))]) {
		const segment = captions.segments[index];
		if (!segment) continue;
		if (!segment.words || segment.words.length === 0) {
			captions.segments.splice(index, 1);
		} else {
			syncSegmentFromWords(segment);
		}
	}
}

export function hideCaptionSpeech(
	captions: Pick<TranscriptCaptions, "transcriptHidden">,
	ranges: readonly SourceRange[],
) {
	captions.transcriptHidden = mergeSourceRanges([
		...(captions.transcriptHidden ?? []),
		...ranges,
	]);
}

function restoreCaptionWord(
	captions: Pick<TranscriptCaptions, "segments">,
	cut: TranscriptCut,
) {
	const text = cut.text?.trim() ?? "";
	if (text.length === 0) return;
	const word = { text, start: cut.start, end: cut.end };
	const midpoint = (word.start + word.end) / 2;
	const live = captions.segments.filter(
		(candidate) => (candidate.words?.length ?? 0) > 0,
	);
	const distance = (candidate: CaptionSegment) =>
		Math.max(candidate.start - word.end, word.start - candidate.end, 0);
	const nearest = Math.min(...live.map(distance));
	const recorded = live.find((candidate) => candidate.id === cut.segmentId);
	const segment =
		live.find(
			(candidate) => midpoint >= candidate.start && midpoint <= candidate.end,
		) ??
		(recorded && distance(recorded) <= nearest + PAUSE_DETECTION_THRESHOLD
			? recorded
			: undefined);

	if (!segment) {
		const index = captions.segments.findIndex(
			(candidate) => candidate.start > word.start,
		);
		const idTaken = captions.segments.some(
			(candidate) => candidate.id === cut.segmentId,
		);
		captions.segments.splice(
			index === -1 ? captions.segments.length : index,
			0,
			{
				id:
					cut.segmentId && !idTaken
						? cut.segmentId
						: `caption-${Date.now()}-${Math.random().toString(36).slice(2)}`,
				start: word.start,
				end: word.end,
				text: word.text,
				words: [word],
			},
		);
		return;
	}

	segment.words ??= [];
	const duplicate = segment.words.some(
		(existing) =>
			existing.text === word.text &&
			Math.min(existing.end, word.end) - Math.max(existing.start, word.start) >
				(word.end - word.start) / 2,
	);
	if (duplicate) return;
	const index = segment.words.findIndex(
		(existing) => existing.start > word.start,
	);
	segment.words.splice(index === -1 ? segment.words.length : index, 0, word);
	syncSegmentFromWords(segment);
}

function restoreTrimmedWords(
	captions: Pick<TranscriptCaptions, "segments">,
	trimmed: readonly TranscriptTrimmedWord[],
	claims: readonly SourceRange[],
) {
	for (const record of trimmed) {
		for (const segment of captions.segments) {
			const word = segment.words?.find(
				(candidate) =>
					Math.abs(candidate.start - record.start) <= WORD_TIME_EPSILON &&
					Math.abs(candidate.end - record.trimmedEnd) <= WORD_TIME_EPSILON,
			);
			if (!word) continue;
			const limit =
				claims.find((claim) => claim.end > record.trimmedEnd + RANGE_EPSILON)
					?.start ?? record.end;
			word.end = Math.max(word.end, Math.min(record.end, limit));
			segment.end = Math.max(segment.end, word.end);
			break;
		}
	}
}

export type TranscriptCutEdit = {
	add?: TranscriptCut[];
	cutWords?: FlatWord[];
	trimWords?: Array<{
		segmentIndex: number;
		wordIndex: number;
		end: number;
		cut: string;
	}>;
	restore?: string[];
	padding?: Array<{ id: string; bufferStart: number; bufferEnd: number }>;
};

export type TranscriptCutResult = "applied" | "transition" | "failed" | "empty";

/**
 * Applies a transcript cut edit in place. The edit list follows the union of
 * every cut's padded range: newly claimed source time is cut out, and time no
 * cut claims any more is re-inserted when the transcript was what removed it.
 * Each cut records the footage it removed, so a piece no cut claims any more
 * comes back with its clip settings and overlays as the removal found them.
 * The project may be partly modified when this returns anything but
 * "applied", so callers run it against a copy first.
 */
export function applyTranscriptCutEdit(
	project: TranscriptProject,
	edit: TranscriptCutEdit,
	recordingSegments: SegmentRecordings[],
): TranscriptCutResult {
	const captions = project.captions;
	if (!captions) return "empty";
	const currentCuts = captions.transcriptCuts ?? [];
	const restoreIds = new Set(edit.restore ?? []);
	const padding = new Map(
		(edit.padding ?? []).map((change) => [change.id, change]),
	);
	const restored = currentCuts.filter((cut) => restoreIds.has(cut.id));
	const added = edit.add ?? [];
	const repadded = currentCuts.filter(
		(cut) => !restoreIds.has(cut.id) && padding.has(cut.id),
	);
	if (restored.length === 0 && added.length === 0 && repadded.length === 0)
		return "empty";

	const nextCuts = [
		...currentCuts.flatMap((cut) => {
			if (restoreIds.has(cut.id)) return [];
			const change = padding.get(cut.id);
			return [
				change
					? clampCutPadding(
							{
								...cut,
								bufferStart: change.bufferStart,
								bufferEnd: change.bufferEnd,
							},
							cutPaddingRoom(captions, cut),
						)
					: cut,
			];
		}),
		...added,
	];

	const previousClaims = cutClaims(currentCuts);
	const nextClaims = cutClaims(nextCuts);
	const removed = mergeSourceRanges(captions.transcriptRemoved ?? []);
	const toRestore = intersectSourceRanges(
		subtractSourceRanges(previousClaims, nextClaims),
		removed,
	);
	const toCut = subtractSourceRanges(nextClaims, previousClaims);
	let nextRemoved = subtractSourceRanges(removed, toRestore);
	const removedPieces = new Map<number, TranscriptCutPiece[]>();

	const timeline = project.timeline;
	if (!timeline && (toRestore.length > 0 || toCut.length > 0)) return "failed";
	if (timeline) {
		if (
			toRestore.length > 0 &&
			restoreTimelineSourceRanges(
				timeline,
				toRestore,
				recordingSegments,
				currentCuts.flatMap((cut) => cut.removed ?? []),
			) === "transition"
		)
			return "transition";

		const coverage = timelineSourceCoverage(
			timeline.segments,
			recordingSegments,
		);
		const present = intersectSourceRanges(toCut, coverage);
		if (present.length > 0) {
			const pieces = cutTimelineSourceRanges(
				timeline,
				claimOwners(nextCuts, present),
				recordingSegments,
				nextPieceSequence(currentCuts),
			);
			if (pieces === "transition") return "transition";
			const cutOut = subtractSourceRanges(
				coverage,
				timelineSourceCoverage(timeline.segments, recordingSegments),
			);
			if (
				sourceRangesDuration(subtractSourceRanges(present, cutOut)) >
				MIN_TIMELINE_CUT
			)
				return "failed";
			nextRemoved = mergeSourceRanges([...nextRemoved, ...cutOut]);
			for (const { owner, piece } of pieces) {
				removedPieces.set(owner, [...(removedPieces.get(owner) ?? []), piece]);
			}
		}
	}

	const trimmedWords = new Map<number, TranscriptTrimmedWord[]>();
	for (const trim of edit.trimWords ?? []) {
		const word = captions.segments[trim.segmentIndex]?.words?.[trim.wordIndex];
		if (word && trim.end > word.start && trim.end < word.end) {
			const owner = nextCuts.findIndex((cut) => cut.id === trim.cut);
			if (owner !== -1)
				trimmedWords.set(owner, [
					...(trimmedWords.get(owner) ?? []),
					{ start: word.start, end: word.end, trimmedEnd: trim.end },
				]);
			word.end = trim.end;
		}
	}
	removeCaptionWords(captions, edit.cutWords ?? []);
	for (const cut of restored) {
		if (cut.kind === "word") restoreCaptionWord(captions, cut);
		restoreTrimmedWords(captions, cut.trimmedWords ?? [], nextClaims);
	}

	const offsets = recordingOffsets(recordingSegments);
	const stillRemoved = (piece: TranscriptCutPiece) => {
		const source = pieceSourceRange(piece, offsets);
		return (
			source !== null &&
			sourceRangesDuration(subtractSourceRanges([source], nextRemoved)) <=
				RANGE_EPSILON
		);
	};
	for (const piece of restored.flatMap((cut) => cut.removed ?? [])) {
		const source = pieceSourceRange(piece, offsets);
		if (!source || !stillRemoved(piece)) continue;
		const owner = nextCuts.findIndex((cut) => {
			const claim = cutClaim(cut);
			return (
				claim !== null && intersectSourceRanges([claim], [source]).length > 0
			);
		});
		if (owner !== -1)
			removedPieces.set(owner, [...(removedPieces.get(owner) ?? []), piece]);
	}
	captions.transcriptCuts = nextCuts.map((cut, index) => {
		const kept = (cut.removed ?? []).filter(stillRemoved);
		const pieces = removedPieces.get(index) ?? [];
		const trims = trimmedWords.get(index) ?? [];
		if (
			kept.length === (cut.removed ?? []).length &&
			pieces.length === 0 &&
			trims.length === 0
		)
			return cut;
		return {
			...cut,
			removed: [...kept, ...pieces],
			trimmedWords: [...(cut.trimmedWords ?? []), ...trims],
		};
	});
	captions.transcriptRemoved = nextRemoved;
	return "applied";
}

function nextPieceSequence(cuts: readonly TranscriptCut[]) {
	let next = 0;
	for (const cut of cuts) {
		for (const piece of cut.removed ?? [])
			next = Math.max(next, piece.sequence + 1);
	}
	return next;
}

export type TranscriptItem =
	| { type: "word"; token: number; word: FlatWord }
	| { type: "cut-word"; token: number; cut: TranscriptCut }
	| { type: "pause"; start: number; end: number }
	| { type: "cut-pause"; cut: TranscriptCut };

export type TranscriptToken =
	| { type: "word"; word: FlatWord }
	| { type: "cut-word"; cut: TranscriptCut };

export function tokenStart(token: TranscriptToken) {
	return token.type === "word" ? token.word.start : token.cut.start;
}

function tokenSpeechEnd(token: TranscriptToken) {
	return token.type === "word" ? spokenWordEnd(token.word) : token.cut.end;
}

export function transcriptTokens(
	words: readonly FlatWord[],
	cuts: readonly TranscriptCut[],
): TranscriptToken[] {
	const cutWords = cuts
		.filter((cut) => cut.kind === "word")
		.sort((a, b) => a.start - b.start);
	const tokens: TranscriptToken[] = [];
	let next = 0;
	for (const word of words) {
		while (next < cutWords.length && cutWords[next].start < word.start) {
			tokens.push({ type: "cut-word", cut: cutWords[next++] });
		}
		tokens.push({ type: "word", word });
	}
	while (next < cutWords.length) {
		tokens.push({ type: "cut-word", cut: cutWords[next++] });
	}
	return tokens;
}

function clipToRange(
	sorted: readonly SourceRange[],
	range: SourceRange,
): SourceRange[] {
	let low = 0;
	let high = sorted.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if (sorted[mid].end <= range.start) low = mid + 1;
		else high = mid;
	}
	const result: SourceRange[] = [];
	for (let i = low; i < sorted.length && sorted[i].start < range.end; i++) {
		const start = Math.max(sorted[i].start, range.start);
		const end = Math.min(sorted[i].end, range.end);
		if (end - start > RANGE_EPSILON) result.push({ start, end });
	}
	return result;
}

export function buildTranscriptItems(
	tokens: readonly TranscriptToken[],
	cuts: readonly TranscriptCut[],
	coverage: readonly SourceRange[],
	speech: readonly SourceRange[] = [],
	threshold = PAUSE_DETECTION_THRESHOLD,
): TranscriptItem[] {
	const cutPauses = cuts
		.filter((cut) => cut.kind === "pause")
		.sort((a, b) => a.start - b.start);
	const silence = subtractSourceRanges(coverage, [...cutPauses, ...speech]);
	const items: TranscriptItem[] = [];
	let nextCutPause = 0;
	const flushCutPauses = (before: number) => {
		while (
			nextCutPause < cutPauses.length &&
			cutPauses[nextCutPause].start < before
		) {
			items.push({ type: "cut-pause", cut: cutPauses[nextCutPause++] });
		}
	};

	tokens.forEach((token, index) => {
		const previous = tokens[index - 1];
		const gap = {
			start: previous ? tokenSpeechEnd(previous) : 0,
			end: tokenStart(token),
		};
		const pauses =
			gap.end - gap.start >= threshold
				? clipToRange(silence, gap).filter(
						(piece) => piece.end - piece.start >= threshold,
					)
				: [];
		for (const pause of pauses) {
			flushCutPauses(pause.start);
			items.push({ type: "pause", start: pause.start, end: pause.end });
		}
		flushCutPauses(tokenStart(token));
		items.push(
			token.type === "word"
				? { type: "word", token: index, word: token.word }
				: { type: "cut-word", token: index, cut: token.cut },
		);
	});
	flushCutPauses(Number.POSITIVE_INFINITY);
	return items;
}

export function newTranscriptCutId() {
	return `cut-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function wordCut(
	word: FlatWord,
	segmentId: string | undefined,
	id: string,
): TranscriptCut {
	return {
		id,
		kind: "word",
		text: word.text,
		start: word.start,
		end: word.end,
		bufferStart: 0,
		bufferEnd: 0,
		segmentId: segmentId ?? null,
	};
}

function pauseCut(range: SourceRange, id: string): TranscriptCut {
	return {
		id,
		kind: "pause",
		text: "",
		start: range.start,
		end: range.end,
		bufferStart: 0,
		bufferEnd: 0,
		segmentId: null,
	};
}

export type PlanContext = {
	items: readonly TranscriptItem[];
	segmentIds: readonly (string | undefined)[];
	coverage: readonly SourceRange[];
	speech: readonly SourceRange[];
	blocked?: (range: SourceRange) => boolean;
	createId?: () => string;
};

type TokenItem = Extract<TranscriptItem, { type: "word" | "cut-word" }>;

function tokenItems(items: readonly TranscriptItem[]) {
	return items.filter(
		(item): item is TokenItem =>
			item.type === "word" || item.type === "cut-word",
	);
}

function itemStart(item: TokenItem) {
	return item.type === "word" ? item.word.start : item.cut.start;
}

function itemEnd(item: TokenItem) {
	return item.type === "word" ? item.word.end : item.cut.end;
}

function trimsForCuts(
	tokens: readonly TokenItem[],
	cuts: readonly TranscriptCut[],
	leaving: ReadonlySet<number>,
) {
	return tokens.flatMap((item) => {
		if (item.type !== "word" || leaving.has(item.token)) return [];
		for (const cut of cuts) {
			const claim = cutClaim(cut);
			if (
				claim &&
				claim.start > item.word.start + RANGE_EPSILON &&
				claim.start < item.word.end - RANGE_EPSILON
			)
				return [
					{
						segmentIndex: item.word.segmentIndex,
						wordIndex: item.word.wordIndex,
						end: claim.start,
						cut: cut.id,
					},
				];
		}
		return [];
	});
}

function planCuts(
	context: PlanContext,
	cutting: ReadonlySet<number>,
	options: {
		joinKeepers: boolean;
		longPauseThreshold?: number;
		skipBlocked?: boolean;
	},
): { edit: TranscriptCutEdit | null; skipped: number } {
	const createId = context.createId ?? newTranscriptCutId;
	const tokens = tokenItems(context.items);
	const silence = subtractSourceRanges(context.coverage, [
		...context.items.flatMap((item) =>
			item.type === "cut-pause" ? [item.cut] : [],
		),
		...context.speech,
	]);
	const records = new Map<number, TranscriptCut>();
	for (const item of tokens) {
		if (item.type !== "word" || !cutting.has(item.token)) continue;
		records.set(
			item.token,
			wordCut(
				item.word,
				context.segmentIds[item.word.segmentIndex],
				createId(),
			),
		);
	}

	const removedAfter = (item: TokenItem) =>
		item.type === "cut-word" || records.has(item.token);
	const gapPauses: Array<{ range: SourceRange; beside: number[] }> = [];
	const bufferedFrom = new Map<number, number>();
	for (let index = 0; index < tokens.length; index++) {
		const current = tokens[index];
		const previous = index > 0 ? tokens[index - 1] : undefined;
		const currentRecord = records.get(current.token);
		const previousRecord = previous ? records.get(previous.token) : undefined;
		if (!currentRecord && !previousRecord) continue;
		const joinsRemoved =
			previous !== undefined && removedAfter(previous) && removedAfter(current);
		if (!joinsRemoved && !options.joinKeepers) continue;

		const gapStart = !previous
			? 0
			: previous.type === "word" && !previousRecord
				? spokenWordEnd(previous.word)
				: itemEnd(previous);
		const gap = itemStart(current) - gapStart;
		if (gap <= RANGE_EPSILON) continue;
		if (gap < PAUSE_DETECTION_THRESHOLD) {
			if (currentRecord) {
				currentRecord.bufferStart = gap;
				if (previous && previousRecord)
					bufferedFrom.set(current.token, previous.token);
			} else if (previousRecord) previousRecord.bufferEnd = gap;
			continue;
		}
		if (!options.joinKeepers && !(currentRecord && previousRecord)) continue;
		const beside = [previous?.token, current.token].filter(
			(token): token is number => token !== undefined && records.has(token),
		);
		for (const range of clipToRange(silence, {
			start: gapStart,
			end: itemStart(current),
		}))
			gapPauses.push({ range, beside });
	}

	for (const record of records.values()) {
		const room = paddingRoom(record, context.speech);
		record.bufferStart = Math.min(record.bufferStart ?? 0, room.before);
		record.bufferEnd = Math.min(record.bufferEnd ?? 0, room.after);
	}

	const longPauses: SourceRange[] = [];
	if (options.longPauseThreshold !== undefined) {
		for (const item of context.items) {
			if (
				item.type === "pause" &&
				item.end - item.start >= options.longPauseThreshold
			) {
				longPauses.push({ start: item.start, end: item.end });
			}
		}
	}

	let skipped = 0;
	const skippedTokens = new Set<number>();
	const blocked = options.skipBlocked ? context.blocked : undefined;
	if (blocked) {
		for (const [token, record] of [...records]) {
			const claim = cutClaim(record);
			if (claim && blocked(claim)) {
				records.delete(token);
				skippedTokens.add(token);
				skipped++;
			}
		}
		for (const [token, from] of bufferedFrom) {
			const record = records.get(token);
			if (record && skippedTokens.has(from)) record.bufferStart = 0;
		}
	}
	let pauseRanges = mergeSourceRanges([
		...gapPauses.flatMap((gap) =>
			gap.beside.some((token) => skippedTokens.has(token)) ? [] : [gap.range],
		),
		...longPauses,
	]);
	if (blocked) {
		const clear = pauseRanges.filter((range) => !blocked(range));
		skipped += pauseRanges.length - clear.length;
		pauseRanges = clear;
	}
	if (records.size === 0 && pauseRanges.length === 0)
		return { edit: null, skipped };
	const add = [
		...records.values(),
		...pauseRanges.map((range) => pauseCut(range, createId())),
	];
	return {
		edit: {
			add,
			cutWords: tokens.flatMap((item) =>
				item.type === "word" && records.has(item.token) ? [item.word] : [],
			),
			trimWords: trimsForCuts(tokens, add, new Set(records.keys())),
		},
		skipped,
	};
}

export function planWordCuts(
	context: PlanContext,
	tokenIndices: Iterable<number>,
): TranscriptCutEdit | null {
	const selected = new Set(tokenIndices);
	const live = new Set<number>();
	for (const item of context.items) {
		if (item.type === "word" && selected.has(item.token)) live.add(item.token);
	}
	if (live.size === 0) return null;
	return planCuts(context, live, { joinKeepers: false }).edit;
}

export function planPauseCut(
	context: PlanContext,
	pause: SourceRange,
): TranscriptCutEdit {
	const cut = pauseCut(pause, (context.createId ?? newTranscriptCutId)());
	return {
		add: [cut],
		trimWords: trimsForCuts(tokenItems(context.items), [cut], new Set()),
	};
}

export function planAutoClean(
	context: PlanContext,
	silenceThreshold: number,
): { edit: TranscriptCutEdit | null; skipped: number } {
	return planCuts(context, fillerTokens(context.items), {
		joinKeepers: true,
		longPauseThreshold: silenceThreshold,
		skipBlocked: true,
	});
}

export function fillerTokens(items: readonly TranscriptItem[]): Set<number> {
	const tokens = tokenItems(items);
	if (
		!readsAsEnglish(
			tokens.map((item) =>
				item.type === "word" ? item.word.text : (item.cut.text ?? ""),
			),
		)
	)
		return new Set();
	return new Set(
		tokens.flatMap((item) =>
			item.type === "word" && isFillerWord(item.word.text) ? [item.token] : [],
		),
	);
}

export function flattenCaptionWords(
	segments: readonly CaptionSegment[],
): FlatWord[] {
	return segments.flatMap((segment, segmentIndex) =>
		(segment.words ?? []).map((word, wordIndex) => ({
			text: word.text,
			start: word.start,
			end: word.end,
			segmentIndex,
			wordIndex,
		})),
	);
}

export function transcriptPlanContext(
	project: TranscriptProject,
	recordingSegments: SegmentRecordings[],
	words?: readonly FlatWord[],
): PlanContext {
	const segments = project.captions?.segments ?? [];
	const cuts = project.captions?.transcriptCuts ?? [];
	const coverage = project.timeline
		? timelineSourceCoverage(project.timeline.segments, recordingSegments)
		: [
				{
					start: 0,
					end: recordingSegments.reduce(
						(total, recording) => total + recording.display.duration,
						0,
					),
				},
			];
	const speech = transcriptSpeech(project.captions);
	const timeline = project.timeline;
	return {
		items: buildTranscriptItems(
			transcriptTokens(words ?? flattenCaptionWords(segments), cuts),
			cuts,
			coverage,
			speech,
		),
		segmentIds: segments.map((segment) => segment.id),
		coverage,
		speech,
		blocked: (range) =>
			timeline
				? sourceRangeBlockedByTransition(timeline, range, recordingSegments)
				: false,
	};
}

export function commitTranscriptCutEdit(
	project: TranscriptProject,
	edit: TranscriptCutEdit,
	recordingSegments: SegmentRecordings[],
): TranscriptCutResult {
	const draft = structuredClone({
		captions: unwrap(project.captions),
		timeline: unwrap(project.timeline),
	});
	const result = applyTranscriptCutEdit(draft, edit, recordingSegments);
	if (result === "applied") {
		applyTranscriptCutEdit(project, edit, recordingSegments);
	}
	return result;
}
