import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCapturedTabInputBatch } from "../shared/input-events";
import { createTabInputCollectorId } from "./input-events";

afterEach(() => vi.unstubAllGlobals());

describe("tab input collector IDs", () => {
	it("uses native secure-context UUIDs when available", () => {
		const id = "67f7620d-a814-4329-acec-044e6aab944c";
		vi.stubGlobal("crypto", { randomUUID: () => id });
		expect(createTabInputCollectorId()).toBe(id);
	});

	it("creates valid, unique v4 IDs without randomUUID", () => {
		let seed = 0;
		vi.stubGlobal("crypto", {
			getRandomValues: (bytes: Uint8Array) => {
				for (let index = 0; index < bytes.length; index++) {
					bytes[index] = seed % 256;
					seed++;
				}
				return bytes;
			},
		});
		const first = createTabInputCollectorId();
		const second = createTabInputCollectorId();
		expect(first).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
		expect(second).not.toBe(first);
		for (const collectorId of [first, second]) {
			expect(
				parseCapturedTabInputBatch({
					target: "offscreen",
					type: "input-events-batch",
					recordingId: "video-1",
					collectorId,
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
				}),
			).not.toBeNull();
		}
	});
});
