import { hasCriticalMemoryPressure, preemptIdleJobs } from "./job-manager";
import { terminateAllSubprocesses } from "./subprocess";

export interface MediaOperationHandle {
	readonly id: string;
	cancel: () => Promise<void> | void;
}

type OperationKind = "audio" | "probe" | "video";

interface ActiveOperation {
	kind: OperationKind;
	cancel: () => Promise<void> | void;
	cancelled: boolean;
}

const activeOperations = new Map<string, ActiveOperation>();
const MAX_CONCURRENT_AUDIO_OPERATIONS = 6;
const MAX_CONCURRENT_PROBE_OPERATIONS = 6;

function createOperationId(kind: OperationKind): string {
	return `${kind}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function getActiveAudioOperationCount(): number {
	let count = 0;
	for (const operation of activeOperations.values()) {
		if (operation.kind === "audio") count++;
	}
	return count;
}

export function getMaxConcurrentAudioOperations(): number {
	return MAX_CONCURRENT_AUDIO_OPERATIONS;
}

export function getMaxConcurrentProbeOperations(): number {
	return MAX_CONCURRENT_PROBE_OPERATIONS;
}

export function canAcceptNewAudioOperation(): boolean {
	return (
		!hasCriticalMemoryPressure() &&
		getActiveAudioOperationCount() < MAX_CONCURRENT_AUDIO_OPERATIONS
	);
}

export function getActiveProbeOperationCount(): number {
	let count = 0;
	for (const operation of activeOperations.values()) {
		if (operation.kind === "probe") count++;
	}
	return count;
}

export function canAcceptNewProbeOperation(): boolean {
	return (
		!hasCriticalMemoryPressure() &&
		getActiveProbeOperationCount() < MAX_CONCURRENT_PROBE_OPERATIONS
	);
}

// Every operation stops an idle job, probes included: a probe beside a running
// idle ladder measured 5 to 10 ms slower. Probes are frequent, so an idle
// ladder only finishes on a quiet worker, which is fine because the share keeps
// playing its MP4 meanwhile. Only the idle job's own operations leave it be.
export interface MediaOperationOptions {
	idle?: boolean;
}

export function registerMediaOperation(
	kind: OperationKind,
	cancel: () => Promise<void> | void,
	options: MediaOperationOptions = {},
): MediaOperationHandle {
	if (!options.idle)
		preemptIdleJobs(`Idle job preempted by ${kind} processing`);
	const id = createOperationId(kind);
	const operation: ActiveOperation = {
		kind,
		cancel,
		cancelled: false,
	};
	activeOperations.set(id, operation);

	return {
		id,
		cancel: async () => {
			if (operation.cancelled) return;
			operation.cancelled = true;
			activeOperations.delete(id);
			await operation.cancel();
		},
	};
}

export function unregisterMediaOperation(handle: MediaOperationHandle): void {
	activeOperations.delete(handle.id);
}

export async function withMediaOperation<T>(
	kind: OperationKind,
	work: (setCancel: (cancel: () => Promise<void> | void) => void) => Promise<T>,
	options: MediaOperationOptions = {},
): Promise<T> {
	let cancel: () => Promise<void> | void = () => {};
	const handle = registerMediaOperation(kind, () => cancel(), options);

	try {
		return await work((nextCancel) => {
			cancel = nextCancel;
		});
	} finally {
		unregisterMediaOperation(handle);
	}
}

export async function cancelAllMediaOperations(): Promise<void> {
	const operations = Array.from(activeOperations.values());
	activeOperations.clear();
	await Promise.allSettled(
		operations.map(async (operation) => {
			if (operation.cancelled) return;
			operation.cancelled = true;
			await operation.cancel();
		}),
	);
	await terminateAllSubprocesses();
}
