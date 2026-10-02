type ActiveSpan = {
	startEpochMs: number;
	startClipMs: number;
	endEpochMs: number | null;
};

export class InputTimeline {
	private spans: ActiveSpan[];
	private clipDurationMs = 0;

	constructor(startEpochMs: number) {
		this.spans = [{ startEpochMs, startClipMs: 0, endEpochMs: null }];
	}

	pause(epochMs: number) {
		const span = this.spans.at(-1);
		if (!span || span.endEpochMs !== null) return;
		span.endEpochMs = Math.max(span.startEpochMs, epochMs);
		this.clipDurationMs =
			span.startClipMs + span.endEpochMs - span.startEpochMs;
	}

	resume(epochMs: number) {
		const span = this.spans.at(-1);
		if (!span || span.endEpochMs === null) return;
		this.spans.push({
			startEpochMs: Math.max(span.endEpochMs, epochMs),
			startClipMs: this.clipDurationMs,
			endEpochMs: null,
		});
	}

	stop(epochMs: number) {
		this.pause(epochMs);
	}

	timeFor(epochMs: number) {
		if (!Number.isFinite(epochMs)) return null;
		let low = 0;
		let high = this.spans.length - 1;
		let candidate = -1;
		while (low <= high) {
			const middle = (low + high) >>> 1;
			const span = this.spans[middle];
			if (epochMs < span.startEpochMs) {
				high = middle - 1;
			} else {
				candidate = middle;
				low = middle + 1;
			}
		}
		if (candidate < 0) return null;
		const span = this.spans[candidate];
		if (span.endEpochMs !== null && epochMs >= span.endEpochMs) return null;
		return Math.max(0, span.startClipMs + epochMs - span.startEpochMs);
	}
}
