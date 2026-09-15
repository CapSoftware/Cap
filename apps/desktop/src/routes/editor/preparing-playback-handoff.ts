export type HandoffPlaybackIntent = { frameNumber: number; playing: boolean };

export function createPreparingPlaybackHandoff(options: {
	initial: HandoffPlaybackIntent;
	start: (frameNumber: number) => Promise<void>;
	stop: () => Promise<void>;
	changed: (intent: HandoffPlaybackIntent, active: boolean) => void;
	settled: (intent: HandoffPlaybackIntent) => void;
	failed: (error: unknown) => void;
}) {
	let intent = { ...options.initial };
	let active = true;
	let alive = true;
	let ready = false;
	let running = false;
	let revision = 0;
	let startAttempted = false;
	let resolve: ((accepted: boolean) => void) | undefined;

	const drain = async () => {
		if (running || !active || !ready || !alive) return;
		running = true;
		let failedRevision: number | undefined;
		let operationRevision = revision;
		try {
			while (alive && active && ready) {
				const version = revision;
				operationRevision = version;
				const current = { ...intent };
				if (startAttempted) {
					await options.stop();
					startAttempted = false;
				}
				if (!alive || version !== revision) continue;
				if (current.playing) {
					startAttempted = true;
					await options.start(current.frameNumber);
				}
				if (!alive || version !== revision) continue;
				active = false;
				startAttempted = false;
				options.changed(current, false);
				options.settled(current);
				resolve?.(true);
				resolve = undefined;
			}
		} catch (error) {
			failedRevision = operationRevision;
			if (alive) options.failed(error);
		} finally {
			if (
				(failedRevision !== undefined || !alive || (active && !ready)) &&
				startAttempted
			) {
				try {
					await options.stop();
				} catch (error) {
					if (alive) options.failed(error);
				}
				startAttempted = false;
			}
			if (alive && failedRevision === revision) {
				active = false;
				options.changed({ ...intent, playing: false }, false);
				resolve?.(false);
				resolve = undefined;
			}
			running = false;
			if (alive && active && ready) void drain();
		}
	};

	return {
		active: () => alive && active,
		intent: () => ({ ...intent }),
		request(next: HandoffPlaybackIntent) {
			if (!alive || !active) return undefined;
			resolve?.(false);
			const changedFrame = next.frameNumber !== intent.frameNumber;
			intent = { ...next };
			revision++;
			if (changedFrame) ready = false;
			options.changed(intent, true);
			const pending = new Promise<boolean>((complete) => {
				resolve = complete;
			});
			void drain();
			return pending;
		},
		retarget(frameNumber: number) {
			if (!alive || !active || frameNumber === intent.frameNumber) return;
			resolve?.(false);
			resolve = undefined;
			intent = { ...intent, frameNumber };
			revision++;
			ready = false;
			options.changed(intent, true);
		},
		acknowledge(frameNumber: number, adopted = false) {
			if (!alive || !active) return;
			if (adopted) {
				intent = { ...intent, frameNumber };
			} else if (frameNumber !== intent.frameNumber) return;
			ready = true;
			void drain();
		},
		dispose() {
			if (!alive) return;
			alive = false;
			revision++;
			resolve?.(false);
			resolve = undefined;
			if (!running && startAttempted) {
				startAttempted = false;
				void options.stop().catch(() => {});
			}
		},
	};
}
