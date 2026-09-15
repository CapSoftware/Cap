import { describe, expect, it } from "vitest";
import { createAudioTrackSegment } from "./audio";
import { type AudioPickerMode, createAudioImportGuard } from "./audio-import";

function setup() {
	let mode: AudioPickerMode = { type: "replace", index: 0 };
	const segments = ["first.wav", "second.wav"].map((path, track) =>
		createAudioTrackSegment({
			start: 0,
			end: 10,
			track,
			path,
			name: path,
			duration: 10,
		}),
	);
	const guard = createAudioImportGuard(
		() => mode,
		(index) => segments[index],
	);
	return {
		guard,
		segments,
		setMode(next: AudioPickerMode) {
			mode = next;
			guard.invalidate();
		},
	};
}

function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

describe("audio imports", () => {
	it("commits a completed replacement only while its original target is unchanged", async () => {
		const { guard, segments } = setup();
		const imported = deferred<string>();
		const request = guard.begin();
		expect(request).toBeDefined();
		if (!request) throw new Error("Missing request");
		const completion = imported.promise.then((path) => {
			if (guard.canCommit(request)) segments[0].path = path;
			guard.finish(request);
		});
		segments[1].volumeDb = -12;
		imported.resolve("replacement.wav");
		await completion;
		expect(segments[0].path).toBe("replacement.wav");
		expect(segments[1].volumeDb).toBe(-12);
	});

	it.each(["delete", "reorder", "trim", "close"] as const)(
		"ignores a deferred replacement after %s",
		async (change) => {
			const { guard, segments } = setup();
			const imported = deferred<string>();
			const request = guard.begin();
			if (!request) throw new Error("Missing request");
			const completion = imported.promise.then((path) => {
				if (guard.canCommit(request)) segments[0].path = path;
			});
			if (change === "delete") segments.splice(0, 1);
			if (change === "reorder") segments.reverse();
			if (change === "trim") segments[0].trimStart = 4;
			if (change === "close") guard.close();
			const expected = structuredClone(segments);
			imported.resolve("replacement.wav");
			await completion;
			expect(segments).toEqual(expected);
		},
	);

	it("rejects an old result after switching away and reopening the same target", () => {
		const { guard, setMode } = setup();
		const first = guard.begin();
		if (!first) throw new Error("Missing request");
		setMode({ type: "replace", index: 1 });
		setMode({ type: "replace", index: 0 });
		const second = guard.begin();
		if (!second) throw new Error("Missing request");
		expect(guard.canCommit(first)).toBe(false);
		expect(guard.finish(first)).toBe(false);
		expect(guard.canCommit(second)).toBe(true);
	});

	it("prevents overlapping file and library imports in one picker", () => {
		const { guard } = setup();
		const first = guard.begin();
		if (!first) throw new Error("Missing request");
		expect(guard.begin()).toBeUndefined();
		expect(guard.finish(first)).toBe(true);
		const second = guard.begin();
		if (!second) throw new Error("Missing request");
		expect(guard.canCommit(first)).toBe(false);
		expect(guard.canCommit(second)).toBe(true);
	});

	it("does not create replacement requests for missing targets", () => {
		const { guard, segments } = setup();
		segments.length = 0;
		expect(guard.begin()).toBeUndefined();
	});

	it("does not retarget the picker when a different segment shifts into its index before import", () => {
		const { guard, segments } = setup();
		segments.splice(0, 1);
		expect(guard.begin()).toBeUndefined();
	});

	it("ignores a canceled add when a different lane is opened", () => {
		const { guard, setMode } = setup();
		setMode({ type: "add", lane: 2 });
		const request = guard.begin();
		if (!request) throw new Error("Missing request");
		expect(guard.canCommit(request)).toBe(true);
		setMode({ type: "add", lane: 3 });
		expect(guard.canCommit(request)).toBe(false);
	});

	it("never accepts another request after the panel is disposed", () => {
		const { guard } = setup();
		const request = guard.begin();
		if (!request) throw new Error("Missing request");
		guard.close();
		expect(guard.canCommit(request)).toBe(false);
		expect(guard.begin()).toBeUndefined();
	});
});
