import type { AudioTrackSegment } from "./audio";

export type AudioPickerMode =
	| { type: "add"; lane: number }
	| { type: "replace"; index: number };

type AudioImportRequest = {
	mode: AudioPickerMode;
	target: string | undefined;
};

export function createAudioImportGuard(
	getMode: () => AudioPickerMode,
	getSegment: (index: number) => AudioTrackSegment | undefined,
) {
	let closed = false;
	let pending: AudioImportRequest | undefined;
	const captureIntent = (): AudioImportRequest => {
		const mode = { ...getMode() };
		return {
			mode,
			target:
				mode.type === "replace"
					? JSON.stringify(getSegment(mode.index))
					: undefined,
		};
	};
	let intent = captureIntent();

	const isPending = (request: AudioImportRequest) =>
		!closed && pending === request;
	const accepts = (request: AudioImportRequest) => {
		const mode = getMode();
		if (request.mode.type === "add") {
			return mode.type === "add" && mode.lane === request.mode.lane;
		}
		return (
			mode.type === "replace" &&
			mode.index === request.mode.index &&
			request.target !== undefined &&
			JSON.stringify(getSegment(mode.index)) === request.target
		);
	};

	return {
		begin() {
			if (closed || pending || !accepts(intent)) return;
			pending = { ...intent };
			return pending;
		},
		canCommit(request: AudioImportRequest) {
			return isPending(request) && accepts(request);
		},
		isPending,
		finish(request: AudioImportRequest) {
			if (!isPending(request)) return false;
			pending = undefined;
			return true;
		},
		invalidate() {
			pending = undefined;
			intent = captureIntent();
		},
		close() {
			closed = true;
			pending = undefined;
		},
	};
}
