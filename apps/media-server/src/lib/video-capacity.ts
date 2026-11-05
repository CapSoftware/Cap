export interface VideoProcessSlot {
	release: () => void;
}

const configuredMaxDirectVideoProcesses =
	Number.parseInt(
		process.env.MEDIA_SERVER_MAX_CONCURRENT_DIRECT_CONVERSIONS ?? "0",
		10,
	) || 0;
const DEFAULT_MAX_CONCURRENT_DIRECT_VIDEO_PROCESSES = 1;

let activeDirectVideoProcessCount = 0;

export function getActiveDirectVideoProcessCount(): number {
	return activeDirectVideoProcessCount;
}

export function getMaxConcurrentDirectVideoProcesses(): number {
	return configuredMaxDirectVideoProcesses > 0
		? configuredMaxDirectVideoProcesses
		: DEFAULT_MAX_CONCURRENT_DIRECT_VIDEO_PROCESSES;
}

export function tryAcquireDirectVideoProcessSlot(
	canAcceptNewVideoProcess: () => boolean,
): VideoProcessSlot | null {
	if (activeDirectVideoProcessCount >= getMaxConcurrentDirectVideoProcesses()) {
		return null;
	}

	if (!canAcceptNewVideoProcess()) {
		return null;
	}

	activeDirectVideoProcessCount += 1;
	let released = false;

	return {
		release: () => {
			if (released) return;
			released = true;
			activeDirectVideoProcessCount = Math.max(
				0,
				activeDirectVideoProcessCount - 1,
			);
		},
	};
}
