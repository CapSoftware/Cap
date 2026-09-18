import { describe, expect, it } from "vitest";
import { observePairedRecorderStarts } from "./recorder-start-sync";

describe("observePairedRecorderStarts", () => {
	it("measures from recorder start events after a long setup delay", () => {
		const screenRecorder = new EventTarget() as MediaRecorder;
		const cameraRecorder = new EventTarget() as MediaRecorder;
		const offsets: number[] = [];
		let time = 0;
		observePairedRecorderStarts(
			screenRecorder,
			cameraRecorder,
			(offset) => offsets.push(offset),
			() => time,
		);

		time = 1_800;
		screenRecorder.dispatchEvent(new Event("start"));
		expect(offsets).toEqual([]);
		time = 1_844.4;
		cameraRecorder.dispatchEvent(new Event("start"));
		expect(offsets).toEqual([44]);

		time = 2_000;
		screenRecorder.dispatchEvent(new Event("start"));
		cameraRecorder.dispatchEvent(new Event("start"));
		expect(offsets).toEqual([44]);
	});
});
