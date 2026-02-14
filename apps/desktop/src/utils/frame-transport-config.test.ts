import { describe, expect, it } from "vitest";
import {
	DEFAULT_FRAME_BUFFER_CONFIG,
	FRAME_BUFFER_MAX_SLOT_SIZE,
	FRAME_BUFFER_MAX_TOTAL_BYTES,
	computeSharedBufferConfig,
} from "./frame-transport-config";

describe("frame-transport-config", () => {
	it("keeps default config for small frames", () => {
		const config = computeSharedBufferConfig(4 * 1024 * 1024);
		expect(config.slotSize).toBe(DEFAULT_FRAME_BUFFER_CONFIG.slotSize);
		expect(config.slotCount).toBe(DEFAULT_FRAME_BUFFER_CONFIG.slotCount);
	});

	it("increases slot size with aligned headroom", () => {
		const config = computeSharedBufferConfig(22 * 1024 * 1024);
		expect(config.slotSize).toBe(28 * 1024 * 1024);
		expect(config.slotCount).toBe(4);
	});

	it("caps slot size and total memory budget", () => {
		const config = computeSharedBufferConfig(80 * 1024 * 1024);
		expect(config.slotSize).toBe(FRAME_BUFFER_MAX_SLOT_SIZE);
		expect(config.slotCount).toBe(2);
		expect(config.slotSize * config.slotCount).toBeLessThanOrEqual(
			FRAME_BUFFER_MAX_TOTAL_BYTES,
		);
	});
});
