import {
	type Accessor,
	createEffect,
	createMemo,
	on,
	onCleanup,
} from "solid-js";

export interface PreviewBounds {
	width: number;
	height: number;
}

export function createPreviewBoundsUpdater(options: {
	current: () => PreviewBounds;
	measure: () => (PreviewBounds & { connected: boolean }) | undefined;
	commit: (bounds: PreviewBounds) => void;
	defer: (bounds: PreviewBounds) => void;
	cancel: () => void;
	requestFrame: (callback: () => void) => number;
	cancelFrame: (id: number) => void;
}) {
	let initialFrameSettled = false;
	let pendingFrame: number | undefined;
	let disposed = false;

	function flushMeasuredBounds() {
		const measured = options.measure();
		if (
			!measured?.connected ||
			!Number.isFinite(measured.width) ||
			!Number.isFinite(measured.height) ||
			measured.width <= 0 ||
			measured.height <= 0
		) {
			return false;
		}
		options.cancel();
		options.commit({ width: measured.width, height: measured.height });
		return true;
	}

	return {
		update(bounds: PreviewBounds, hasFrame: boolean) {
			if (disposed) return;
			if (hasFrame && !initialFrameSettled && flushMeasuredBounds()) {
				if (pendingFrame === undefined) {
					pendingFrame = options.requestFrame(() => {
						pendingFrame = undefined;
						if (!disposed && flushMeasuredBounds()) {
							initialFrameSettled = true;
						}
					});
				}
				return;
			}
			const current = options.current();
			if (current.width === 0 && current.height === 0) {
				options.commit(bounds);
			} else {
				options.defer(bounds);
			}
		},
		dispose() {
			disposed = true;
			options.cancel();
			if (pendingFrame !== undefined) {
				options.cancelFrame(pendingFrame);
				pendingFrame = undefined;
			}
		},
	};
}

export function createPreviewBoundsReaction(options: {
	bounds: Accessor<PreviewBounds>;
	hasFrame: Accessor<boolean>;
	updater: ReturnType<typeof createPreviewBoundsUpdater>;
}) {
	const hasFrame = createMemo(options.hasFrame);
	onCleanup(() => options.updater.dispose());
	createEffect(
		on(
			() => {
				const { width, height } = options.bounds();
				return [width, height, hasFrame()] as const;
			},
			([width, height, available]) => {
				options.updater.update({ width, height }, available);
			},
		),
	);
	return hasFrame;
}
