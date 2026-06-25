import { describe, expect, it } from "vitest";
import {
	areEditSpecsEquivalent,
	areTimelineStatesEquivalent,
	composeEditSpecs,
	createIdentityEditSpec,
	createTimelineHistory,
	createTimelineState,
	deleteSelectedTimelineSegment,
	dragTimelineDisplaySplitPoint,
	findNextPlayableTime,
	getTimelineDisplayDuration,
	getTimelineDisplaySegments,
	getTimelineDisplaySplitPoints,
	getTimelineKeepRanges,
	getTimelineSegments,
	mapOutputTimeToSourceTime,
	mapSourceTimeToOutputTime,
	mapTimelineDisplayTimeToSourceTime,
	mapTimelineSourceTimeToDisplayTime,
	normalizeKeepRanges,
	pushTimelineHistory,
	redoTimelineHistory,
	remapCurrentOutputTimeThroughEdit,
	removeSplitPoint,
	removeTimelineDisplaySplitPoint,
	selectTimelineSegment,
	splitTimelineAt,
	trimTimelineClipEdge,
	undoTimelineHistory,
} from "@/lib/video-edits";

describe("video edit specs", () => {
	it("normalizes keep ranges", () => {
		const spec = normalizeKeepRanges(
			[
				{ start: 8, end: 12 },
				{ start: 2, end: 4 },
				{ start: 3.5, end: 5 },
				{ start: Number.NaN, end: 0.01 },
			],
			10,
		);

		expect(spec).toEqual({
			version: 1,
			sourceDuration: 10,
			keepRanges: [
				{ start: 2, end: 5 },
				{ start: 8, end: 10 },
			],
		});
	});

	it("maps source and output timestamps", () => {
		const spec = normalizeKeepRanges(
			[
				{ start: 1, end: 3 },
				{ start: 5, end: 8 },
			],
			10,
		);

		expect(mapSourceTimeToOutputTime(2, spec)).toBe(1);
		expect(mapSourceTimeToOutputTime(4, spec)).toBeNull();
		expect(mapOutputTimeToSourceTime(3, spec)).toBe(6);
	});

	it("composes repeated edits through the retained source", () => {
		const previousSpec = normalizeKeepRanges(
			[
				{ start: 0, end: 4 },
				{ start: 6, end: 10 },
			],
			10,
		);
		const nextOutputSpec = normalizeKeepRanges([{ start: 1, end: 6 }], 8);
		const composed = composeEditSpecs(previousSpec, nextOutputSpec);

		expect(composed.keepRanges).toEqual([
			{ start: 1, end: 4 },
			{ start: 6, end: 8 },
		]);
		expect(remapCurrentOutputTimeThroughEdit(5, previousSpec, composed)).toBe(
			4,
		);
		expect(
			remapCurrentOutputTimeThroughEdit(7, previousSpec, composed),
		).toBeNull();
	});

	it("creates an identity edit spec", () => {
		expect(createIdentityEditSpec(4.2)).toEqual({
			version: 1,
			sourceDuration: 4.2,
			keepRanges: [{ start: 0, end: 4.2 }],
		});
	});

	it("detects normalized no-op edit specs", () => {
		expect(
			areEditSpecsEquivalent(
				{
					version: 1,
					sourceDuration: 10,
					keepRanges: [{ start: 0, end: 10 }],
				},
				{
					version: 1,
					sourceDuration: 10,
					keepRanges: [
						{ start: 0, end: 4 },
						{ start: 4, end: 10 },
					],
				},
			),
		).toBe(true);

		expect(
			areEditSpecsEquivalent(
				createIdentityEditSpec(10),
				normalizeKeepRanges([{ start: 1, end: 10 }], 10),
			),
		).toBe(false);
	});
});

describe("timeline editing", () => {
	it("splits, selects, and deletes a segment", () => {
		const splitState = splitTimelineAt(createTimelineState(10), 4);
		const firstSegment = getTimelineSegments(splitState)[0];
		expect(firstSegment).toBeDefined();

		const selected = selectTimelineSegment(splitState, firstSegment?.id ?? "");
		const deleted = deleteSelectedTimelineSegment(selected);

		expect(getTimelineKeepRanges(deleted)).toEqual([{ start: 4, end: 10 }]);
	});

	it("collapses deleted segments out of the displayed timeline", () => {
		const splitState = splitTimelineAt(
			splitTimelineAt(createTimelineState(10), 3),
			7,
		);
		const middleSegment = getTimelineSegments(splitState)[1];
		expect(middleSegment).toBeDefined();
		if (!middleSegment) throw new Error("Expected middle segment");

		const deleted = deleteSelectedTimelineSegment(
			selectTimelineSegment(splitState, middleSegment.id),
		);

		expect(getTimelineKeepRanges(deleted)).toEqual([
			{ start: 0, end: 3 },
			{ start: 7, end: 10 },
		]);
		expect(getTimelineDisplayDuration(deleted)).toBe(6);
		expect(
			getTimelineDisplaySegments(deleted).map(
				({ start, end, displayStart, displayEnd }) => ({
					start,
					end,
					displayStart,
					displayEnd,
				}),
			),
		).toEqual([
			{ start: 0, end: 3, displayStart: 0, displayEnd: 3 },
			{ start: 7, end: 10, displayStart: 3, displayEnd: 6 },
		]);
		expect(
			getTimelineDisplaySplitPoints(deleted).map(
				({ time, sourceTimes, splitIndices }) => ({
					time,
					sourceTimes,
					splitIndices,
				}),
			),
		).toEqual([{ time: 3, sourceTimes: [3, 7], splitIndices: [0, 1] }]);
		expect(mapTimelineSourceTimeToDisplayTime(deleted, 7)).toBe(3);
		expect(mapTimelineDisplayTimeToSourceTime(deleted, 3)).toBe(3);
	});

	it("removes a collapsed display split by restoring the deleted segment", () => {
		const splitState = splitTimelineAt(
			splitTimelineAt(createTimelineState(10), 3),
			7,
		);
		const middleSegment = getTimelineSegments(splitState)[1];
		expect(middleSegment).toBeDefined();
		if (!middleSegment) throw new Error("Expected middle segment");

		const deleted = deleteSelectedTimelineSegment(
			selectTimelineSegment(splitState, middleSegment.id),
		);
		const restored = removeTimelineDisplaySplitPoint(deleted, 0);

		expect(getTimelineKeepRanges(restored)).toEqual([{ start: 0, end: 10 }]);
		expect(getTimelineDisplaySplitPoints(restored)).toEqual([]);
	});

	it("drags a collapsed display split to shrink either adjacent clip", () => {
		const splitState = splitTimelineAt(
			splitTimelineAt(createTimelineState(10), 3),
			7,
		);
		const middleSegment = getTimelineSegments(splitState)[1];
		expect(middleSegment).toBeDefined();
		if (!middleSegment) throw new Error("Expected middle segment");

		const deleted = deleteSelectedTimelineSegment(
			selectTimelineSegment(splitState, middleSegment.id),
		);
		const leftShrunk = dragTimelineDisplaySplitPoint(deleted, 0, "center", 2);
		const rightShrunk = dragTimelineDisplaySplitPoint(deleted, 0, "center", 8);

		expect(getTimelineKeepRanges(leftShrunk)).toEqual([
			{ start: 0, end: 2 },
			{ start: 7, end: 10 },
		]);
		expect(getTimelineDisplaySplitPoints(leftShrunk)[0]?.sourceTimes).toEqual([
			2, 7,
		]);
		expect(getTimelineKeepRanges(rightShrunk)).toEqual([
			{ start: 0, end: 3 },
			{ start: 8, end: 10 },
		]);
		expect(getTimelineDisplaySplitPoints(rightShrunk)[0]?.sourceTimes).toEqual([
			3, 8,
		]);
	});

	it("restores a deleted segment when removing its split boundary", () => {
		const splitState = splitTimelineAt(
			splitTimelineAt(createTimelineState(10), 3),
			7,
		);
		const middleSegment = getTimelineSegments(splitState)[1];
		expect(middleSegment).toBeDefined();
		if (!middleSegment) throw new Error("Expected middle segment");

		const deleted = deleteSelectedTimelineSegment(
			selectTimelineSegment(splitState, middleSegment.id),
		);
		expect(getTimelineKeepRanges(deleted)).toEqual([
			{ start: 0, end: 3 },
			{ start: 7, end: 10 },
		]);

		const afterFirstSplitRemoved = removeSplitPoint(deleted, 0);
		expect(
			getTimelineSegments(afterFirstSplitRemoved).map(
				({ start, end, deleted }) => ({
					start,
					end,
					deleted,
				}),
			),
		).toEqual([
			{ start: 0, end: 7, deleted: false },
			{ start: 7, end: 10, deleted: false },
		]);

		const afterSecondSplitRemoved = removeSplitPoint(afterFirstSplitRemoved, 0);
		expect(
			getTimelineSegments(afterSecondSplitRemoved).map(
				({ start, end, deleted }) => ({
					start,
					end,
					deleted,
				}),
			),
		).toEqual([{ start: 0, end: 10, deleted: false }]);
		expect(getTimelineKeepRanges(afterSecondSplitRemoved)).toEqual([
			{ start: 0, end: 10 },
		]);
	});

	it("trims an inner clip from either edge without touching its neighbours", () => {
		const splitState = splitTimelineAt(createTimelineState(10), 4);
		const [firstClip, secondClip] = getTimelineDisplaySegments(splitState);
		if (!firstClip || !secondClip) throw new Error("Expected two clips");

		const secondTrimmedLeft = trimTimelineClipEdge(
			splitState,
			secondClip.id,
			"start",
			6,
		);
		expect(getTimelineKeepRanges(secondTrimmedLeft)).toEqual([
			{ start: 0, end: 4 },
			{ start: 6, end: 10 },
		]);

		const firstTrimmedRight = trimTimelineClipEdge(
			splitState,
			firstClip.id,
			"end",
			3,
		);
		expect(getTimelineKeepRanges(firstTrimmedRight)).toEqual([
			{ start: 0, end: 3 },
			{ start: 4, end: 10 },
		]);
	});

	it("never lets a clip edge carve into the adjacent clip", () => {
		const splitState = splitTimelineAt(createTimelineState(10), 4);
		const [firstClip, secondClip] = getTimelineDisplaySegments(splitState);
		if (!firstClip || !secondClip) throw new Error("Expected two clips");

		// First clip's right edge dragged past its own end stops at the boundary.
		expect(
			getTimelineKeepRanges(
				trimTimelineClipEdge(splitState, firstClip.id, "end", 8),
			),
		).toEqual([{ start: 0, end: 10 }]);

		// Second clip's left edge dragged before its own start stops at the boundary.
		expect(
			getTimelineKeepRanges(
				trimTimelineClipEdge(splitState, secondClip.id, "start", 1),
			),
		).toEqual([{ start: 0, end: 10 }]);
	});

	it("carves (does not un-collapse) when the outer clip already has trimmed-off footage", () => {
		// Front: delete [0,2] so the first visible clip is source 2-10.
		const frontDeleted = deleteSelectedTimelineSegment(
			selectTimelineSegment(
				splitTimelineAt(createTimelineState(10), 2),
				getTimelineSegments(splitTimelineAt(createTimelineState(10), 2))[0]
					?.id ?? "",
			),
		);
		const frontClip = getTimelineDisplaySegments(frontDeleted)[0];
		if (!frontClip) throw new Error("Expected a leading clip");
		const frontTrimmed = trimTimelineClipEdge(
			frontDeleted,
			frontClip.id,
			"start",
			4,
		);
		expect(getTimelineKeepRanges(frontTrimmed)).toEqual([
			{ start: 4, end: 10 },
		]);
		// Display stays collapsed (6s), not ballooned back to 10s.
		expect(getTimelineDisplayDuration(frontTrimmed)).toBe(6);

		// Back: delete [8,10] so the last visible clip is source 0-8.
		const backDeleted = deleteSelectedTimelineSegment(
			selectTimelineSegment(
				splitTimelineAt(createTimelineState(10), 8),
				getTimelineSegments(splitTimelineAt(createTimelineState(10), 8))[1]
					?.id ?? "",
			),
		);
		const backSegments = getTimelineDisplaySegments(backDeleted);
		const backClip = backSegments[backSegments.length - 1];
		if (!backClip) throw new Error("Expected a trailing clip");
		const backTrimmed = trimTimelineClipEdge(
			backDeleted,
			backClip.id,
			"end",
			6,
		);
		expect(getTimelineKeepRanges(backTrimmed)).toEqual([{ start: 0, end: 6 }]);
		expect(getTimelineDisplayDuration(backTrimmed)).toBe(6);
	});

	it("moves the global in/out point from the outermost clip edges", () => {
		const splitState = splitTimelineAt(createTimelineState(10), 4);
		const [firstClip, secondClip] = getTimelineDisplaySegments(splitState);
		if (!firstClip || !secondClip) throw new Error("Expected two clips");

		expect(
			getTimelineKeepRanges(
				trimTimelineClipEdge(splitState, firstClip.id, "start", 2),
			),
		).toEqual([{ start: 2, end: 10 }]);
		expect(
			getTimelineKeepRanges(
				trimTimelineClipEdge(splitState, secondClip.id, "end", 8),
			),
		).toEqual([{ start: 0, end: 8 }]);
	});

	it("tracks undo and redo state", () => {
		const initial = createTimelineState(10);
		const history = createTimelineHistory(initial);
		const nextHistory = pushTimelineHistory(
			history,
			splitTimelineAt(initial, 5),
		);
		const undone = undoTimelineHistory(nextHistory);
		const redone = redoTimelineHistory(undone);

		expect(
			getTimelineSegments(undone.entries[undone.index] ?? initial),
		).toHaveLength(1);
		expect(
			getTimelineSegments(redone.entries[redone.index] ?? initial),
		).toHaveLength(2);
	});

	it("detects timeline draft changes independently from output changes", () => {
		const initial = createTimelineState(10);
		const split = splitTimelineAt(initial, 5);
		const initialSegment = getTimelineSegments(initial)[0];
		expect(initialSegment).toBeDefined();
		if (!initialSegment) throw new Error("Expected initial segment");
		const selected = selectTimelineSegment(initial, initialSegment.id);

		expect(areTimelineStatesEquivalent(initial, split)).toBe(false);
		expect(areTimelineStatesEquivalent(initial, selected)).toBe(true);
		expect(
			areEditSpecsEquivalent(
				normalizeKeepRanges(getTimelineKeepRanges(initial), initial.duration),
				normalizeKeepRanges(getTimelineKeepRanges(split), split.duration),
			),
		).toBe(true);
	});

	it("finds preview skip targets", () => {
		const spec = normalizeKeepRanges(
			[
				{ start: 0, end: 2 },
				{ start: 5, end: 8 },
			],
			10,
		);

		expect(findNextPlayableTime(1, spec)).toBe(1);
		expect(findNextPlayableTime(3, spec)).toBe(5);
		expect(findNextPlayableTime(8.1, spec)).toBeNull();
	});
});
