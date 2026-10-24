import { describe, expect, it, vi } from "vitest";
import {
	areaSelectionSyncData,
	createAreaSelectionStorageSync,
	createDefaultAreaSelectionPreferences,
	cropBoundsEqual,
	getLockedAreaBounds,
	ratiosEqual,
} from "./area-selection";

const minimumSize = { width: 150, height: 150 };
const bounds = { x: 120, y: 80, width: 1280, height: 720 };

describe("getLockedAreaBounds", () => {
	it("returns a copy of a valid locked selection for its display", () => {
		const preferences = {
			...createDefaultAreaSelectionPreferences(),
			locked: true,
			screenId: "display-1",
			bounds,
		};

		const restored = getLockedAreaBounds(preferences, "display-1", minimumSize);

		expect(restored).toEqual(bounds);
		expect(restored).not.toBe(bounds);
	});

	it("does not restore an unlocked selection or one from another display", () => {
		const preferences = {
			...createDefaultAreaSelectionPreferences(),
			screenId: "display-1",
			bounds,
		};

		expect(
			getLockedAreaBounds(preferences, "display-1", minimumSize),
		).toBeUndefined();
		expect(
			getLockedAreaBounds(
				{ ...preferences, locked: true },
				"display-2",
				minimumSize,
			),
		).toBeUndefined();
	});

	it("rejects undersized and non-finite stored bounds", () => {
		const preferences = {
			...createDefaultAreaSelectionPreferences(),
			locked: true,
			screenId: "display-1",
			bounds: { ...bounds, width: 149 },
		};

		expect(
			getLockedAreaBounds(preferences, "display-1", minimumSize),
		).toBeUndefined();
		expect(
			getLockedAreaBounds(
				{ ...preferences, bounds: { ...bounds, x: Number.NaN } },
				"display-1",
				minimumSize,
			),
		).toBeUndefined();
	});
});

describe("area selection comparisons", () => {
	it("compares crop bounds by value", () => {
		expect(cropBoundsEqual({ ...bounds }, bounds)).toBe(true);
		expect(cropBoundsEqual({ ...bounds, y: 81 }, bounds)).toBe(false);
		expect(cropBoundsEqual(null, bounds)).toBe(false);
	});

	it("compares aspect ratios by value", () => {
		expect(ratiosEqual([16, 9], [16, 9])).toBe(true);
		expect(ratiosEqual([16, 9], [4, 3])).toBe(false);
		expect(ratiosEqual(null, undefined)).toBe(true);
	});
});

describe("area selection storage sync", () => {
	it("keeps one listener and replaces the active subscriber", () => {
		let listener:
			| ((event: {
					key: string | null;
					newValue: string | null;
					timeStamp: number;
			  }) => void)
			| undefined;
		const subscribeToStorage = vi.fn((nextListener) => {
			listener = nextListener;
		});
		const sync = createAreaSelectionStorageSync(subscribeToStorage);
		const firstSubscriber = vi.fn();
		const secondSubscriber = vi.fn();

		sync[0](firstSubscriber);
		sync[0](secondSubscriber);
		listener?.({ key: "selection", newValue: "{}", timeStamp: 42 });

		expect(subscribeToStorage).toHaveBeenCalledTimes(1);
		expect(firstSubscriber).not.toHaveBeenCalled();
		expect(secondSubscriber).toHaveBeenCalledWith({
			key: "selection",
			newValue: "{}",
			timeStamp: 42,
		});
	});

	it("forwards updates without tying them to one overlay URL", () => {
		expect(
			areaSelectionSyncData({
				key: "selection",
				newValue: "{}",
				timeStamp: 42,
			}),
		).toEqual({ key: "selection", newValue: "{}", timeStamp: 42 });
		expect(
			areaSelectionSyncData({ key: null, newValue: null, timeStamp: 42 }),
		).toBeNull();
	});
});
