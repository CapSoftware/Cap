import { createSignal } from "solid-js";
import toast from "solid-toast";
import { commands } from "~/utils/tauri";
import { rememberClipInsert } from "./clip-insert";
import { useEditorContext } from "./context";

/**
 * Adds files to the open web project: videos and Cap recordings become clips
 * (the editor reloads to pick them up), audio lands on a lane of its own.
 */
export function createWebMediaImport() {
	const {
		project,
		projectActions,
		flushProjectConfig,
		editorInstance,
		editorState,
		setEditorState,
	} = useEditorContext();
	const [busy, setBusy] = createSignal(false);

	const pause = async () => {
		if (!editorState.playing) return;
		await commands.stopPlayback();
		setEditorState("playing", false);
	};

	const addAudio = async (path: string, name: string) => {
		if (busy()) return;
		setBusy(true);
		const toastId = toast.loading("Adding audio…");
		try {
			await pause();
			const imported = await commands.importAudioTrackFile(path);
			const lanes = (project.timeline?.audioSegments ?? []).map(
				(segment) => segment.track ?? 0,
			);
			projectActions.addAudioSegment(
				lanes.length > 0 ? Math.max(...lanes) + 1 : 0,
				imported,
			);
			toast.success(`Added ${name}`, { id: toastId });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			toast.error(`Couldn't add ${name}: ${message}`, { id: toastId });
		} finally {
			setBusy(false);
		}
	};

	const addClip = async (path: string, name: string, insertAt?: number) => {
		if (busy()) return;
		setBusy(true);
		const toastId = toast.loading("Adding clip…");
		try {
			await pause();
			await flushProjectConfig();
			const clipCount = project.timeline?.segments.length ?? 0;
			rememberClipInsert(editorInstance.path, insertAt ?? clipCount, clipCount);
			const count = await commands.addExistingRecordingToEditor(path);
			toast.success(count === 1 ? "Clip added" : `${count} clips added`, {
				id: toastId,
			});
			window.location.reload();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			toast.error(`Couldn't add ${name}: ${message}`, { id: toastId });
			setBusy(false);
		}
	};

	return { busy, addAudio, addClip };
}
