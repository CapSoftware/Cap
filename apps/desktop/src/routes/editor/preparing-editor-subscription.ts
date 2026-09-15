import type { PreparingEditorChanged } from "~/utils/tauri";
import type {
	PreparingEditorController,
	PreparingEditorModel,
	PreparingEditorSeed,
} from "./preparing-editor-model";

function supportedTrack(
	track: string,
): track is NonNullable<PreparingEditorSeed["tracks"]>[number] {
	return (
		track === "display" ||
		track === "camera" ||
		track === "microphone" ||
		track === "systemAudio"
	);
}

export function createPreparingEditorSubscription(options: {
	requestEpoch: number;
	model: PreparingEditorModel;
	listen: (
		accept: (snapshot: PreparingEditorChanged) => void,
	) => Promise<() => void>;
	getState: () => Promise<PreparingEditorChanged | null>;
	controller: (jobId: string) => PreparingEditorController;
}) {
	let active = true;
	let listening: Promise<boolean> | undefined;
	let unlisten: (() => void) | undefined;
	let binding: { jobId: string; fps: number } | undefined;
	const accept = (snapshot: PreparingEditorChanged | null) => {
		if (!active || !snapshot || snapshot.requestEpoch !== options.requestEpoch)
			return false;
		if (!binding) {
			if (
				!options.model.bind(
					snapshot,
					options.controller(snapshot.jobId),
					snapshot.fps,
				)
			)
				return false;
			binding = { jobId: snapshot.jobId, fps: snapshot.fps };
		}
		if (snapshot.jobId !== binding.jobId || snapshot.fps !== binding.fps)
			return false;
		return options.model.accept({
			...snapshot,
			seed: {
				title: snapshot.seed.title,
				tracks: snapshot.seed.tracks.filter(supportedTrack),
			},
		});
	};
	return {
		accept,
		listen() {
			listening ??= options
				.listen(accept)
				.then((cleanup) => {
					if (!active) {
						cleanup();
						return false;
					}
					unlisten = cleanup;
					return true;
				})
				.catch(() => false);
			return listening;
		},
		async refresh() {
			if (!active) return false;
			try {
				return accept(await options.getState());
			} catch {
				return false;
			}
		},
		stopListening() {
			unlisten?.();
			unlisten = undefined;
		},
		dispose() {
			active = false;
			unlisten?.();
			unlisten = undefined;
		},
	};
}
