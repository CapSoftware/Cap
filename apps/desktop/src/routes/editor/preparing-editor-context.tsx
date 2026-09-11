import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
	createContext,
	createEffect,
	createSignal,
	getOwner,
	onCleanup,
	onMount,
	type ParentProps,
	runWithOwner,
	useContext,
} from "solid-js";
import type { FrameData } from "~/utils/socket";
import { commands, events } from "~/utils/tauri";
import {
	createPreparingEditorModel,
	type PreparingEditorModel,
} from "./preparing-editor-model";
import { createPreparingEditorSubscription } from "./preparing-editor-subscription";
import { createPreparingFrameLease } from "./preparing-frame-lease";
import { attachPreparingFrameTransport } from "./preparing-frame-transport";
import { createPreparingHandoff } from "./preparing-handoff";
import type { createPreparingPlaybackHandoff } from "./preparing-playback-handoff";

function createPreparingEditorSession() {
	const model = createPreparingEditorModel();
	const handoff = createPreparingHandoff();
	const owner = getOwner();
	let alive = true;
	let candidate:
		| {
				instanceId: string;
				fps: number;
				progressive: boolean;
				retry: () => Promise<unknown>;
				requestFrame: () => void;
		  }
		| undefined;
	let refreshing: Promise<unknown> | undefined;
	const retryCandidate = () => {
		if (!candidate || refreshing || !alive) return refreshing;
		handoff.invalidatePending();
		playbackHandoff?.dispose();
		refreshing = candidate.retry().finally(() => {
			refreshing = undefined;
		});
		return refreshing;
	};
	let playbackHandoff:
		| ReturnType<typeof createPreparingPlaybackHandoff>
		| undefined;
	const [canvases, setCanvases] = createSignal<{
		active: HTMLCanvasElement;
		retained: HTMLCanvasElement;
	}>();
	const [retained, setRetained] = createSignal(false);
	const [ordinaryReady, setOrdinaryReady] = createSignal(false);
	const lease = createPreparingFrameLease({
		start: async (epoch) => {
			const url = await commands.createPreparingEditorFrame(epoch);
			await subscription.refresh();
			return url;
		},
		stop: (epoch) => commands.stopPreparingEditorFrame(epoch),
		ended: (hasRetainedFrame) => setRetained(hasRetainedFrame),
		attach: (url, isActive) => {
			const pair = canvases();
			if (!pair) throw new Error("Preparing canvas owner is unavailable");
			const transport = runWithOwner(owner, () =>
				attachPreparingFrameTransport({
					url,
					canvas: pair.active,
					retainedCanvas: pair.retained,
					isActive,
					onRendered: model.setRendered,
					onTerminal: () => lease.finish(),
				}),
			);
			if (!transport) throw new Error("Preparing frame owner ended");
			return transport;
		},
	});
	const subscription = createPreparingEditorSubscription({
		requestEpoch: lease.requestEpoch,
		model,
		listen: (accept) =>
			events
				.preparingEditorChanged(getCurrentWebviewWindow())
				.listen(({ payload }) => accept(payload)),
		getState: () => commands.getPreparingEditorState(lease.requestEpoch),
		controller: (jobId) => ({
			seek: async (seconds) => {
				await commands.seekPreparingEditor(lease.requestEpoch, jobId, seconds);
			},
			setPlaying: async (playing) => {
				await commands.setPreparingEditorPlaying(
					lease.requestEpoch,
					jobId,
					playing,
				);
			},
		}),
	});
	onMount(() => {
		const active = document.createElement("canvas");
		const preserved = document.createElement("canvas");
		for (const canvas of [active, preserved]) {
			canvas.className =
				"absolute max-w-full max-h-full object-contain rounded-md";
			canvas.setAttribute(
				"aria-label",
				"Recording preview while the editor prepares",
			);
		}
		setCanvases({ active, retained: preserved });
		void subscription.listen().then(async (ready) => {
			if (ready) {
				await lease.start();
				if (!lease.isActive()) subscription.stopListening();
			} else lease.close();
		});
	});
	createEffect(() => {
		const pair = canvases();
		if (!pair) return;
		pair.active.classList.toggle(
			"invisible",
			!model.rendered() || retained() || ordinaryReady(),
		);
		pair.retained.classList.toggle("invisible", !retained() || ordinaryReady());
	});
	onCleanup(() => {
		alive = false;
		handoff.invalidatePending();
		subscription.dispose();
		lease.close();
		model.dispose();
		const pair = canvases();
		pair?.active.remove();
		pair?.retained.remove();
	});
	return {
		model,
		canvases,
		retained,
		ordinaryReady,
		acceptSnapshot: subscription.accept,
		beginHandoff(
			fps: number,
			recordingDuration: number,
			value: NonNullable<typeof candidate>,
		) {
			candidate = value;
			const target = handoff.begin(
				model.playback(),
				fps,
				recordingDuration,
				value.instanceId,
			);
			if (target && value.progressive)
				handoff.setAdvancing(target.playback.playing, target.frameNumber);
			return target;
		},
		retryCandidate,
		invalidatePending: handoff.invalidatePending,
		holdOrdinaryFrames() {
			const release = handoff.holdFrames();
			return () => {
				if (release() && alive) candidate?.requestFrame();
			};
		},
		handoffTarget: handoff.target,
		handoffRequestedFrame: handoff.requestedFrame,
		setPlaybackHandoff(value: typeof playbackHandoff) {
			playbackHandoff = value;
		},
		requestOrdinaryFrame(frameNumber: number, explicit = false) {
			if (
				!explicit &&
				candidate?.progressive &&
				!ordinaryReady() &&
				model.playback().playing
			)
				return frameNumber;
			const actual = handoff.requestFrame(
				frameNumber,
				playbackHandoff?.active(),
			);
			playbackHandoff?.retarget(actual);
			return actual;
		},
		setOrdinaryAdvancing(playing: boolean, frameNumber: number) {
			if (candidate?.progressive && !ordinaryReady()) return;
			handoff.setAdvancing(playing, frameNumber);
		},
		acknowledgeOrdinaryFrame(
			frame: FrameData,
			bounds: { width: number; height: number },
		) {
			const current = candidate;
			const frameNumber = frame.renderedFrame?.frameNumber;
			if (!alive || !current || frameNumber === undefined) return;
			if (ordinaryReady()) {
				if (handoff.matches(frame, bounds))
					playbackHandoff?.acknowledge(frameNumber);
				return;
			}
			const pending = handoff.commitFrame(frame, bounds, () =>
				current.progressive
					? commands.commitEditorPreparingFrame(
							current.instanceId,
							frameNumber,
							current.fps,
						)
					: Promise.resolve(true),
			);
			void pending
				?.then((accepted) => {
					if (!alive || candidate !== current) return;
					if (!accepted) {
						current.requestFrame();
						return;
					}
					playbackHandoff?.acknowledge(frameNumber, current.progressive);
					setOrdinaryReady(true);
					lease.close();
				})
				.catch((error: unknown) => {
					if (!alive || candidate !== current) return;
					if (String(error) === "Preparing handoff candidate was superseded") {
						void retryCandidate()?.catch((cause: unknown) =>
							console.error("Failed to replace preparing editor:", cause),
						);
					} else {
						console.error("Failed to accept preparing editor frame:", error);
					}
				});
		},
	};
}

const PreparingEditorContext =
	createContext<ReturnType<typeof createPreparingEditorSession>>();

export function PreparingEditorProvider(props: ParentProps) {
	const session = createPreparingEditorSession();
	return (
		<PreparingEditorContext.Provider value={session}>
			{props.children}
		</PreparingEditorContext.Provider>
	);
}

export function usePreparingEditor() {
	return useContext(PreparingEditorContext);
}

export function usePreparingEditorModel(): PreparingEditorModel {
	const session = usePreparingEditor();
	if (session) return session.model;
	const model = createPreparingEditorModel();
	onCleanup(() => model.dispose());
	return model;
}
