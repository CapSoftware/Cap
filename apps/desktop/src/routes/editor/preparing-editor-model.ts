import { batch, createMemo, createSignal } from "solid-js";

import type {
	PreparingEditorProgress,
	PreparingPlaybackState,
} from "~/utils/tauri";

export type {
	PreparingEditorProgress,
	PreparingPlaybackState,
} from "~/utils/tauri";

export type PreparingEditorSeed = {
	title?: string;
	tracks?: readonly ("display" | "camera" | "microphone" | "systemAudio")[];
};

export type PreparingEditorIdentity = {
	requestEpoch: number;
	jobId: string;
};

export type PreparingEditorSnapshot = PreparingEditorIdentity & {
	sequence: number;
	progress: PreparingEditorProgress;
	playback: PreparingPlaybackState;
	seed?: PreparingEditorSeed;
};

export type PreparingEditorController = {
	seek: (seconds: number) => Promise<void>;
	setPlaying: (playing: boolean) => Promise<void>;
};

export function preparingTimeline(progress: PreparingEditorProgress) {
	const duration = progress.totalDuration;
	const totalDuration =
		duration !== null && Number.isFinite(duration) && duration > 0
			? duration
			: null;
	const confirmed = Number.isFinite(progress.playableUntil)
		? Math.max(0, progress.playableUntil)
		: 0;
	const playableUntil =
		progress.phase === "unavailable" || totalDuration === null
			? 0
			: Math.min(confirmed, totalDuration);
	return {
		totalDuration,
		playableUntil,
		fraction: totalDuration === null ? null : playableUntil / totalDuration,
	};
}

export function preparingTime(seconds: number) {
	const whole = Math.floor(Math.max(0, Number.isFinite(seconds) ? seconds : 0));
	const hours = Math.floor(whole / 3600);
	const minutes = Math.floor((whole % 3600) / 60);
	const remainder = (whole % 60).toString().padStart(2, "0");
	return hours > 0
		? `${hours}:${minutes.toString().padStart(2, "0")}:${remainder}`
		: `${minutes}:${remainder}`;
}

function sameIdentity(
	left: PreparingEditorIdentity | undefined,
	right: PreparingEditorIdentity,
) {
	return (
		left?.requestEpoch === right.requestEpoch && left.jobId === right.jobId
	);
}

const waitingProgress = (): PreparingEditorProgress => ({
	totalDuration: null,
	playableUntil: 0,
	previewAvailable: false,
	phase: "preparing",
});
const waitingPlayback = (): PreparingPlaybackState => ({
	playheadSeconds: 0,
	playing: false,
	buffering: false,
});

export function createPreparingEditorModel() {
	const [progress, setProgress] = createSignal(waitingProgress());
	const [playback, setPlayback] = createSignal(waitingPlayback());
	const [seed, setSeed] = createSignal<PreparingEditorSeed>({});
	const [controller, setController] = createSignal<PreparingEditorController>();
	const [commandPending, setCommandPending] = createSignal(false);
	const [commandError, setCommandError] = createSignal<string>();
	const [rendered, setRendered] = createSignal(false);
	let identity: PreparingEditorIdentity | undefined;
	let sequence = -1;
	let disposed = false;
	let binding = 0;
	let framesPerSecond = 0;
	const timeline = createMemo(() => preparingTimeline(progress()));
	const canPlay = createMemo(
		() =>
			!!controller() &&
			progress().phase === "preparing" &&
			progress().previewAvailable &&
			rendered() &&
			timeline().playableUntil > 0 &&
			!commandPending(),
	);
	const execute = async (
		operation: (value: PreparingEditorController) => Promise<void>,
	) => {
		const current = controller();
		if (!canPlay() || !current || disposed) return false;
		const requestBinding = binding;
		setCommandPending(true);
		setCommandError(undefined);
		try {
			await operation(current);
			return (
				requestBinding === binding &&
				!disposed &&
				progress().phase === "preparing"
			);
		} catch (error) {
			if (requestBinding === binding && !disposed) {
				setCommandError(error instanceof Error ? error.message : String(error));
			}
			return false;
		} finally {
			if (requestBinding === binding && !disposed) setCommandPending(false);
		}
	};
	return {
		progress,
		playback,
		seed,
		timeline,
		canPlay,
		commandPending,
		commandError,
		rendered,
		setRendered,
		bind(
			next: PreparingEditorIdentity,
			nextController: PreparingEditorController,
			fps: number,
		) {
			if (
				disposed ||
				!Number.isSafeInteger(fps) ||
				fps <= 0 ||
				fps > 0xffffffff ||
				!Number.isSafeInteger(next.requestEpoch) ||
				next.requestEpoch <= 0 ||
				!next.jobId ||
				identity
			) {
				return false;
			}
			identity = { ...next };
			framesPerSecond = fps;
			binding++;
			setController(() => nextController);
			return true;
		},
		accept(snapshot: PreparingEditorSnapshot) {
			if (
				disposed ||
				!sameIdentity(identity, snapshot) ||
				!Number.isSafeInteger(snapshot.sequence) ||
				snapshot.sequence <= sequence
			) {
				return false;
			}
			sequence = snapshot.sequence;
			const next = snapshot.progress;
			const position = snapshot.playback;
			if (
				(next.totalDuration !== null &&
					(!Number.isFinite(next.totalDuration) || next.totalDuration < 0)) ||
				!Number.isFinite(next.playableUntil) ||
				next.playableUntil < 0 ||
				(next.totalDuration === null && next.playableUntil > 0) ||
				(next.totalDuration !== null &&
					next.playableUntil > next.totalDuration) ||
				!Number.isFinite(position.playheadSeconds) ||
				position.playheadSeconds < 0
			) {
				batch(() => {
					setProgress({ ...waitingProgress(), phase: "unavailable" });
					setPlayback(waitingPlayback());
				});
				return false;
			}
			batch(() => {
				setProgress({ ...next });
				setPlayback({ ...position });
				if (snapshot.seed) {
					setSeed({
						title: snapshot.seed.title,
						tracks: snapshot.seed.tracks && [...snapshot.seed.tracks],
					});
				}
			});
			return true;
		},
		seek(seconds: number) {
			if (!Number.isFinite(seconds) || seconds < 0)
				return Promise.resolve(false);
			const finalFrame =
				Math.ceil(timeline().playableUntil * framesPerSecond) - 1;
			if (
				!Number.isSafeInteger(finalFrame) ||
				finalFrame < 0 ||
				finalFrame > 0xffffffff
			)
				return Promise.resolve(false);
			const targetFrame = Math.min(
				Math.floor(seconds * framesPerSecond),
				finalFrame,
			);
			return execute((value) => value.seek(targetFrame / framesPerSecond));
		},
		setPlaying(playing: boolean) {
			return execute(async (value) => {
				const current = timeline();
				if (
					playing &&
					current.totalDuration !== null &&
					current.playableUntil === current.totalDuration &&
					current.totalDuration - playback().playheadSeconds <= 0.1
				) {
					await value.seek(0);
					if (disposed || progress().phase !== "preparing") return;
				}
				await value.setPlaying(playing);
			});
		},
		dispose() {
			disposed = true;
			binding++;
			setController(undefined);
			setCommandPending(false);
		},
	};
}

export type PreparingEditorModel = ReturnType<
	typeof createPreparingEditorModel
>;
