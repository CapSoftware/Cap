import { afterEach, describe, expect, it } from "vitest";
import {
	seekLength,
	setFullLength,
} from "@/app/s/[videoId]/_components/early-length";
import { createPlaybackStore } from "@/app/s/[videoId]/_components/playback/playback-store";

const fakeVideo = (duration: number) =>
	Object.assign(new EventTarget(), {
		currentTime: 10,
		duration,
		paused: true,
		ended: false,
	}) as unknown as HTMLVideoElement;

describe("Early playback full length", () => {
	const video = fakeVideo(44);
	afterEach(() => setFullLength(video, null));

	it("leaves the loaded duration alone without a full length", () => {
		expect(seekLength(video, 44)).toBe(44);
		expect(seekLength(null, 44)).toBe(44);
		expect(seekLength(video, Number.NaN)).toBeNaN();
	});

	it("lets seeks reach the full length while it is known", () => {
		setFullLength(video, 120);
		expect(seekLength(video, 44)).toBe(120);
		expect(seekLength(video, Number.NaN)).toBe(120);
		expect(seekLength(video, 130)).toBe(130);
		setFullLength(video, null);
		expect(seekLength(video, 44)).toBe(44);
	});

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
		"ignores an unusable full length (%s)",
		(seconds) => {
			setFullLength(video, seconds);
			expect(seekLength(video, 44)).toBe(44);
		},
	);

	it("passes a timeline or comment seek past the loaded part through", () => {
		const element = fakeVideo(44);
		const store = createPlaybackStore();
		store.attach(element);
		store.seek(90);
		expect(element.currentTime).toBeCloseTo(43.999, 3);

		setFullLength(element, 120);
		store.seek(90);
		expect(element.currentTime).toBe(90);
		store.detach();
		setFullLength(element, null);
	});
});
