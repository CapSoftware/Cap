import { describe, expect, it } from "vitest";
import {
	createConsumer,
	createProducer,
	createSharedFrameBuffer,
} from "./shared-frame-buffer";

function makeFrame(...bytes: number[]): ArrayBuffer {
	return new Uint8Array(bytes).buffer;
}

function readFirstByte(frame: ArrayBuffer | null): number | null {
	if (!frame) return null;
	const view = new Uint8Array(frame);
	if (view.byteLength === 0) return null;
	return view[0];
}

describe("shared-frame-buffer", () => {
	it("claims alternate writable slot when write index slot is busy", () => {
		const init = createSharedFrameBuffer({ slotCount: 3, slotSize: 64 });
		const producer = createProducer(init);
		const consumer = createConsumer(init.buffer);

		expect(producer.write(makeFrame(1))).toBe(true);
		expect(producer.write(makeFrame(2))).toBe(true);

		const held = consumer.borrow(0);
		expect(held).not.toBeNull();
		expect(held && held.data[0]).toBe(1);

		const next = consumer.read(0);
		expect(readFirstByte(next)).toBe(2);

		expect(producer.write(makeFrame(3))).toBe(true);
		expect(producer.write(makeFrame(4))).toBe(true);

		held?.release();

		const firstRemaining = consumer.read(0);
		const secondRemaining = consumer.read(0);
		const remaining = [
			readFirstByte(firstRemaining),
			readFirstByte(secondRemaining),
		]
			.filter((value): value is number => value !== null)
			.sort((a, b) => a - b);
		expect(remaining).toEqual([3, 4]);
	});

	it("reads ready slot beyond current read index", () => {
		const init = createSharedFrameBuffer({ slotCount: 3, slotSize: 64 });
		const producer = createProducer(init);
		const consumer = createConsumer(init.buffer);

		expect(producer.write(makeFrame(10))).toBe(true);
		expect(producer.write(makeFrame(11))).toBe(true);

		const held = consumer.borrow(0);
		expect(held).not.toBeNull();
		expect(held && held.data[0]).toBe(10);

		const bypassRead = consumer.read(0);
		expect(readFirstByte(bypassRead)).toBe(11);

		held?.release();
	});

	it("readInto consumes sparse-ready slot and returns size", () => {
		const init = createSharedFrameBuffer({ slotCount: 3, slotSize: 64 });
		const producer = createProducer(init);
		const consumer = createConsumer(init.buffer);

		expect(producer.write(makeFrame(21, 22, 23))).toBe(true);
		expect(producer.write(makeFrame(31, 32))).toBe(true);

		const held = consumer.borrow(0);
		expect(held?.data[0]).toBe(21);

		const target = new Uint8Array(64);
		const bytesRead = consumer.readInto(target, 0);
		expect(bytesRead).toBe(2);
		expect(Array.from(target.subarray(0, 2))).toEqual([31, 32]);

		held?.release();
	});

	it("overwrites ready slot when ring is full", () => {
		const init = createSharedFrameBuffer({ slotCount: 2, slotSize: 64 });
		const producer = createProducer(init);
		const consumer = createConsumer(init.buffer);

		expect(producer.write(makeFrame(1))).toBe(true);
		expect(producer.write(makeFrame(2))).toBe(true);
		expect(producer.write(makeFrame(3))).toBe(true);

		const first = readFirstByte(consumer.read(0));
		const second = readFirstByte(consumer.read(0));
		const values = [first, second]
			.filter((value): value is number => value !== null)
			.sort((a, b) => a - b);

		expect(values).toEqual([2, 3]);
	});
});
