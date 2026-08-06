import type {
	PersistenceSyncAPI,
	PersistenceSyncCallback,
	PersistenceSyncData,
} from "@solid-primitives/storage";
import type { CropBounds, Ratio } from "~/components/Cropper";
import type { DisplayId } from "~/utils/tauri";

export const AREA_SELECTION_STORAGE_KEY = "target-select-area-preferences-v1";
export const AREA_SELECTION_STORAGE_SYNC = createAreaSelectionStorageSync(
	(listener) => window.addEventListener("storage", listener),
);

export function createAreaSelectionStorageSync(
	subscribeToStorage: (
		listener: (
			event: Pick<StorageEvent, "key" | "newValue" | "timeStamp">,
		) => void,
	) => void,
): PersistenceSyncAPI {
	let activeSubscriber: PersistenceSyncCallback | undefined;
	let subscribed = false;

	return [
		(subscriber) => {
			activeSubscriber = subscriber;
			if (subscribed) return;

			subscribeToStorage((event) => {
				const data = areaSelectionSyncData(event);
				if (data) activeSubscriber?.(data);
			});
			subscribed = true;
		},
		() => {},
	];
}

export function areaSelectionSyncData(
	event: Pick<StorageEvent, "key" | "newValue" | "timeStamp">,
): PersistenceSyncData | null {
	if (event.key === null) return null;
	return {
		key: event.key,
		newValue: event.newValue,
		timeStamp: event.timeStamp,
	};
}

export const QUICK_AREA_RATIOS: readonly Ratio[] = [
	[16, 9],
	[4, 3],
	[1, 1],
];

export type AreaSelectionPreferences = {
	locked: boolean;
	screenId: DisplayId | null;
	bounds: CropBounds | null;
	aspectRatio: Ratio | null;
	snapToRatio: boolean;
};

export function createDefaultAreaSelectionPreferences(): AreaSelectionPreferences {
	return {
		locked: false,
		screenId: null,
		bounds: null,
		aspectRatio: null,
		snapToRatio: true,
	};
}

export function cropBoundsEqual(
	left: CropBounds | null,
	right: CropBounds,
): boolean {
	return (
		left !== null &&
		left.x === right.x &&
		left.y === right.y &&
		left.width === right.width &&
		left.height === right.height
	);
}

export function ratiosEqual(
	left: Ratio | null | undefined,
	right: Ratio | null | undefined,
): boolean {
	if (!left || !right) return !left && !right;
	return left[0] === right[0] && left[1] === right[1];
}

export function getLockedAreaBounds(
	preferences: AreaSelectionPreferences,
	displayId: DisplayId,
	minimumSize: { width: number; height: number },
): CropBounds | undefined {
	const bounds = preferences.bounds;
	if (!preferences.locked || preferences.screenId !== displayId || !bounds)
		return undefined;

	if (
		![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
		bounds.width < minimumSize.width ||
		bounds.height < minimumSize.height
	)
		return undefined;

	return { ...bounds };
}
