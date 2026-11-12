import { stat } from "node:fs/promises";
import { EncodeStalledError } from "./ffmpeg-errors";

// Before the first frame comes out an encoder is filling its lookahead, which
// on a large or slowly decoded source takes minutes. Once frames are coming, a
// gap this long means the process is stuck.
export const ENCODE_START_STALL_MS = 10 * 60_000;
export const ENCODE_STALL_MS = 5 * 60_000;
const CHECK_INTERVAL_MS = 15_000;

// -progress prints one counter a line. Without it FFmpeg prints the same
// counters padded on a single status line, which is what an edit produces.
const PROGRESS_FIELDS = /(?:^|\s)(out_time_us|frame|total_size|size)=\s*(\d+)/g;

export interface EncodeStallWindows {
	startMs: number;
	stallMs: number;
	checkIntervalMs?: number;
}

export interface EncodeStallWatch {
	observe(text: string): void;
	stalled: Promise<never>;
	stop(): void;
}

export function watchEncodeProgress(
	outputPath: string,
	windows: EncodeStallWindows = {
		startMs: ENCODE_START_STALL_MS,
		stallMs: ENCODE_STALL_MS,
	},
): EncodeStallWatch {
	const highest = new Map<string, number>();
	let lastAdvanceAt = performance.now();
	let advanced = false;
	let outputState = "";
	let checking = false;
	let fail: (error: Error) => void = () => {};
	const stalled = new Promise<never>((_resolve, reject) => {
		fail = reject;
	});
	stalled.catch(() => {});

	const timer = setInterval(async () => {
		if (checking) return;
		checking = true;
		try {
			// FFmpeg reports nothing while it finishes a file: moving the index
			// to the front rewrites the whole output. Writes to it count as
			// progress, so a large output is not mistaken for a stall.
			const info = await stat(outputPath).catch(() => null);
			const state = info ? `${info.size}:${info.mtimeMs}` : "";
			if (state !== outputState) {
				outputState = state;
				lastAdvanceAt = performance.now();
				return;
			}
			const idleMs = performance.now() - lastAdvanceAt;
			if (idleMs < (advanced ? windows.stallMs : windows.startMs)) return;
			clearInterval(timer);
			fail(new EncodeStalledError(idleMs));
		} finally {
			checking = false;
		}
	}, windows.checkIntervalMs ?? CHECK_INTERVAL_MS);
	timer.unref?.();

	return {
		observe(text) {
			for (const field of text.matchAll(PROGRESS_FIELDS)) {
				const value = Number(field[2]);
				if (value <= (highest.get(field[1] as string) ?? 0)) continue;
				highest.set(field[1] as string, value);
				lastAdvanceAt = performance.now();
				advanced = true;
			}
		},
		stalled,
		stop() {
			clearInterval(timer);
		},
	};
}
