import type { FrameData } from "~/utils/socket";
import type { PreparingPlaybackState } from "./preparing-editor-model";

export function createPreparingHandoff() {
	let target:
		| { frameNumber: number; playback: PreparingPlaybackState }
		| undefined;
	let complete = false;
	let identity: string | undefined;
	let revision = 0;
	let pending: symbol | undefined;
	const holds = new Set<symbol>();
	let expectedFrame: number | undefined;
	let advancing = false;
	let finalFrame: number | null = null;
	const matches = (
		frame: FrameData,
		bounds: { width: number; height: number },
	) => {
		if (
			!target ||
			expectedFrame === undefined ||
			frame.renderedFrame === undefined ||
			(advancing
				? frame.renderedFrame.frameNumber < expectedFrame ||
					(finalFrame !== null && frame.renderedFrame.frameNumber > finalFrame)
				: frame.renderedFrame.frameNumber !== expectedFrame) ||
			!Number.isFinite(frame.width) ||
			!Number.isFinite(frame.height) ||
			frame.width <= 0 ||
			frame.height <= 0 ||
			!Number.isFinite(bounds.width) ||
			!Number.isFinite(bounds.height) ||
			bounds.width <= 0 ||
			bounds.height <= 0
		) {
			return false;
		}
		return true;
	};
	return {
		begin(
			playback: PreparingPlaybackState,
			fps: number,
			totalDuration: number | null = null,
			nextIdentity?: string,
		) {
			if (nextIdentity !== undefined && nextIdentity !== identity) {
				identity = nextIdentity;
				revision += 1;
				pending = undefined;
				complete = false;
				target = undefined;
				expectedFrame = undefined;
				advancing = false;
				finalFrame = null;
			}
			if (target) return target;
			const requested = Math.floor(playback.playheadSeconds * fps);
			const lastFrame =
				totalDuration !== null &&
				Number.isFinite(totalDuration) &&
				totalDuration > 0
					? Math.max(0, Math.ceil(totalDuration * fps) - 1)
					: null;
			const frameNumber =
				lastFrame === null ? requested : Math.min(requested, lastFrame);
			if (
				!Number.isFinite(fps) ||
				fps <= 0 ||
				!Number.isSafeInteger(frameNumber) ||
				frameNumber < 0 ||
				frameNumber > 0xffffffff
			) {
				return undefined;
			}
			target = {
				frameNumber,
				playback: {
					...playback,
					playheadSeconds:
						lastFrame === null
							? playback.playheadSeconds
							: Math.min(playback.playheadSeconds, totalDuration ?? 0),
				},
			};
			expectedFrame = frameNumber;
			finalFrame = lastFrame;
			return target;
		},
		target: () => target,
		requestedFrame: () => expectedFrame,
		requestFrame(frameNumber: number, pendingPlayback = false) {
			if (!target || (complete && !pendingPlayback)) return frameNumber;
			const bounded =
				finalFrame === null ? frameNumber : Math.min(frameNumber, finalFrame);
			if (!Number.isSafeInteger(bounded) || bounded < 0 || bounded > 0xffffffff)
				return frameNumber;
			if (expectedFrame !== bounded || advancing) revision += 1;
			expectedFrame = bounded;
			advancing = false;
			return bounded;
		},
		setAdvancing(playing: boolean, startFrame: number) {
			if (
				!target ||
				complete ||
				!Number.isSafeInteger(startFrame) ||
				startFrame < 0
			)
				return;
			const bounded =
				finalFrame === null ? startFrame : Math.min(startFrame, finalFrame);
			if (expectedFrame !== bounded || advancing !== playing) revision += 1;
			expectedFrame = bounded;
			advancing = playing;
		},
		invalidatePending() {
			revision += 1;
			pending = undefined;
		},
		holdFrames() {
			const hold = Symbol();
			holds.add(hold);
			revision += 1;
			pending = undefined;
			return () => holds.delete(hold);
		},
		commitFrame(
			frame: FrameData,
			bounds: { width: number; height: number },
			approve: () => Promise<boolean>,
		): Promise<boolean> | undefined {
			const rendered = frame.renderedFrame?.frameNumber;
			if (
				complete ||
				holds.size > 0 ||
				pending ||
				rendered === undefined ||
				!Number.isSafeInteger(rendered) ||
				rendered < 0 ||
				rendered > 0xffffffff ||
				!matches(frame, bounds)
			)
				return undefined;
			const token = Symbol();
			const requestedRevision = revision;
			const requestedIdentity = identity;
			const requestedTarget = target;
			const requestedFrame = expectedFrame;
			pending = token;
			const current = () =>
				!complete &&
				pending === token &&
				revision === requestedRevision &&
				identity === requestedIdentity &&
				target === requestedTarget &&
				expectedFrame === requestedFrame;
			return (async () => {
				try {
					const approved = await approve();
					if (approved !== true || !current()) return false;
					complete = true;
					return true;
				} catch (error) {
					if (!current()) return false;
					throw error;
				} finally {
					if (pending === token) pending = undefined;
				}
			})();
		},
		accept(frame: FrameData, bounds: { width: number; height: number }) {
			if (complete || !matches(frame, bounds)) return false;
			complete = true;
			return true;
		},
		matches,
	};
}
