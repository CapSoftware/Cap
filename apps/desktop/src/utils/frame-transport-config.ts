import type { SharedFrameBufferConfig } from "./shared-frame-buffer";

export const DEFAULT_FRAME_BUFFER_CONFIG: SharedFrameBufferConfig = {
	slotCount: 6,
	slotSize: 16 * 1024 * 1024,
};

export const FRAME_BUFFER_RESIZE_ALIGNMENT = 2 * 1024 * 1024;
export const FRAME_BUFFER_MAX_SLOT_SIZE = 64 * 1024 * 1024;
export const FRAME_BUFFER_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
export const FRAME_BUFFER_MIN_SLOT_COUNT = 2;

export function alignUp(value: number, alignment: number): number {
	if (alignment <= 0) return value;
	return Math.ceil(value / alignment) * alignment;
}

export function computeSharedBufferConfig(
	requiredBytes: number,
	baseConfig: SharedFrameBufferConfig = DEFAULT_FRAME_BUFFER_CONFIG,
): SharedFrameBufferConfig {
	const safeRequired = Math.max(requiredBytes, 0);
	const withHeadroom = Math.ceil(safeRequired * 1.25);
	const alignedBytes = alignUp(withHeadroom, FRAME_BUFFER_RESIZE_ALIGNMENT);
	const slotSize = Math.max(
		baseConfig.slotSize,
		Math.min(FRAME_BUFFER_MAX_SLOT_SIZE, alignedBytes),
	);

	const maxSlotsByBudget = Math.max(
		FRAME_BUFFER_MIN_SLOT_COUNT,
		Math.floor(FRAME_BUFFER_MAX_TOTAL_BYTES / slotSize),
	);
	const slotCount = Math.min(baseConfig.slotCount, maxSlotsByBudget);

	return { slotCount, slotSize };
}
