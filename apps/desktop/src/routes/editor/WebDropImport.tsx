import { createSignal, onCleanup, onMount, Show } from "solid-js";
import toast from "solid-toast";
import { pathForDroppedFile } from "~/utils/dropped-files";
import { commands } from "~/utils/tauri";
import { useEditorContext } from "./context";

const AUDIO_FILE = /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|weba)$/i;
const VIDEO_FILE = /\.(mp4|mov|m4v|webm|mkv)$/i;
const CAP_FILE = /\.capbundle$/i;

const hasFiles = (event: DragEvent) =>
	Array.from(event.dataTransfer?.types ?? []).includes("Files");

const kindOf = (file: File) =>
	CAP_FILE.test(file.name)
		? "clip"
		: file.type.startsWith("audio/") || AUDIO_FILE.test(file.name)
			? "audio"
			: file.type.startsWith("video/") || VIDEO_FILE.test(file.name)
				? "clip"
				: null;

/**
 * Drop a file anywhere on the web editor: videos and Cap recordings become
 * clips at the end of the timeline, audio lands on a lane of its own.
 */
export function WebDropImport() {
	const {
		project,
		projectActions,
		flushProjectConfig,
		editorState,
		setEditorState,
	} = useEditorContext();
	const [dragging, setDragging] = createSignal(false);
	const [busy, setBusy] = createSignal(false);
	let depth = 0;

	const importFile = async (file: File) => {
		const kind = kindOf(file);
		const path = kind ? pathForDroppedFile(file) : null;
		if (!kind || !path) {
			toast.error("Drop a video, an audio file or a Cap recording");
			return;
		}
		setBusy(true);
		const toastId = toast.loading(
			kind === "audio" ? "Adding audio…" : "Adding clip…",
		);
		try {
			if (editorState.playing) {
				await commands.stopPlayback();
				setEditorState("playing", false);
			}
			if (kind === "audio") {
				const imported = await commands.importAudioTrackFile(path);
				const lanes = (project.timeline?.audioSegments ?? []).map(
					(segment) => segment.track ?? 0,
				);
				projectActions.addAudioSegment(
					lanes.length > 0 ? Math.max(...lanes) + 1 : 0,
					imported,
				);
				toast.success(`Added ${file.name}`, { id: toastId });
				setBusy(false);
				return;
			}
			await flushProjectConfig();
			const count = await commands.addExistingRecordingToEditor(path);
			toast.success(count === 1 ? "Clip added" : `${count} clips added`, {
				id: toastId,
			});
			window.location.reload();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			toast.error(`Couldn't add ${file.name}: ${message}`, { id: toastId });
			setBusy(false);
		}
	};

	onMount(() => {
		const enter = (event: DragEvent) => {
			if (!hasFiles(event) || busy()) return;
			event.preventDefault();
			depth += 1;
			setDragging(true);
		};
		const over = (event: DragEvent) => {
			if (!hasFiles(event) || busy()) return;
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
		};
		const leave = () => {
			depth = Math.max(0, depth - 1);
			if (depth === 0) setDragging(false);
		};
		const drop = (event: DragEvent) => {
			if (!hasFiles(event)) return;
			event.preventDefault();
			depth = 0;
			setDragging(false);
			const file = event.dataTransfer?.files[0];
			if (file && !busy()) void importFile(file);
		};
		window.addEventListener("dragenter", enter);
		window.addEventListener("dragover", over);
		window.addEventListener("dragleave", leave);
		window.addEventListener("drop", drop);
		onCleanup(() => {
			window.removeEventListener("dragenter", enter);
			window.removeEventListener("dragover", over);
			window.removeEventListener("dragleave", leave);
			window.removeEventListener("drop", drop);
		});
	});

	return (
		<Show when={dragging()}>
			<div class="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center bg-black/25 backdrop-blur-[2px]">
				<div class="absolute inset-3 rounded-2xl border-2 border-dashed border-ed-accent opacity-70" />
				<div class="flex max-w-sm flex-col items-center gap-1.5 rounded-2xl bg-ed-card px-7 py-5 text-center shadow-ed-card">
					<span class="text-[15px] font-medium text-ed-text-1">
						Drop to add to your project
					</span>
					<span class="text-[13px] leading-snug text-ed-text-2">
						Videos and Cap recordings go on the end of your timeline. Audio gets
						a track of its own.
					</span>
				</div>
			</div>
		</Show>
	);
}
