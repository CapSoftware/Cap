import { describe, expect, it } from "vitest";
import { parseCapturedTabInputBatch } from "./input-events";

const batch = {
	target: "offscreen",
	type: "input-events-batch",
	recordingId: "video-1",
	collectorId: "67f7620d-a814-4329-acec-044e6aab944c",
	sequence: 0,
	platform: "MacIntel",
	viewportWidth: 1273,
	viewportHeight: 716,
	events: [
		{
			kind: "down",
			epochMs: 1_000,
			x: 0.5,
			y: 0.5,
			cursor: "pointer",
			button: 0,
			modifiers: [],
		},
	],
};

describe("tab input batches", () => {
	it("accepts a bounded native event batch", () => {
		expect(parseCapturedTabInputBatch(batch)).toEqual(batch);
	});

	it("rejects overflow and invalid cursor coordinates", () => {
		expect(
			parseCapturedTabInputBatch({
				...batch,
				events: Array.from({ length: 129 }, () => batch.events[0]),
			}),
		).toBeNull();
		expect(
			parseCapturedTabInputBatch({
				...batch,
				events: [{ ...batch.events[0], x: Number.NaN }],
			}),
		).toBeNull();
		expect(
			parseCapturedTabInputBatch({
				...batch,
				events: [{ ...batch.events[0], cursor: "url(https://example.com)" }],
			}),
		).toBeNull();
	});
});
