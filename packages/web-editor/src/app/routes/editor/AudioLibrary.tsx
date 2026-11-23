import {
	createEffect,
	createMemo,
	createSignal,
	on,
	onCleanup,
	Show,
} from "solid-js";
import toast from "solid-toast";
import { commands } from "../../../engine/editor-api";
import { pickFile } from "../../../engine/file-picker";
import { AUDIO_IMPORT_EXTENSIONS } from "./audio";
import { type AudioPickerMode, createAudioImportGuard } from "./audio-import";
import { useEditorContext } from "./context";
import { EditorButton } from "./ui";

export function AudioLibraryPanel(props: {
	mode: AudioPickerMode;
	onClose: () => void;
}) {
	const { project, projectActions } = useEditorContext();
	const [uploading, setUploading] = createSignal(false);

	const isReplace = () => props.mode.type === "replace";
	const imports = createAudioImportGuard(
		() => props.mode,
		(index) => project.timeline?.audioSegments?.[index],
	);
	const pickerModeKey = createMemo(() =>
		props.mode.type === "replace"
			? `replace:${props.mode.index}`
			: `add:${props.mode.lane}`,
	);
	createEffect(
		on(
			pickerModeKey,
			() => {
				imports.invalidate();
				setUploading(false);
			},
			{ defer: true },
		),
	);

	onCleanup(() => imports.close());

	const close = () => {
		imports.close();
		props.onClose();
	};

	const uploadTrack = async () => {
		if (uploading()) return;
		const request = imports.begin();
		if (!request) {
			close();
			return;
		}
		setUploading(true);
		try {
			const file = await pickFile(AUDIO_IMPORT_EXTENSIONS);
			if (!file || !imports.canCommit(request)) {
				if (imports.isPending(request)) close();
				return;
			}
			const imported = await commands.importAudioTrackFile(file);
			if (!imports.canCommit(request)) {
				if (imports.isPending(request)) close();
				return;
			}
			if (request.mode.type === "replace")
				projectActions.replaceAudioSegment(request.mode.index, imported);
			else projectActions.addAudioSegment(request.mode.lane, imported);
			close();
		} catch (error) {
			if (!imports.canCommit(request)) return;
			console.error("Failed to import audio file", error);
			toast.error("Failed to import audio file");
		} finally {
			if (imports.finish(request)) setUploading(false);
		}
	};

	return (
		<div class="flex flex-col gap-4">
			<div class="flex flex-row gap-2 items-center">
				<EditorButton onClick={close} leftIcon={<IconLucideCheck />}>
					Done
				</EditorButton>
				<span class="text-sm text-gray-10">
					{isReplace() ? "Change audio" : "Add audio"}
				</span>
			</div>

			<p class="text-xs text-gray-10">
				{isReplace()
					? "Pick a different track for this segment"
					: "Add audio, music or other sounds to your video"}
			</p>

			<button
				type="button"
				disabled={uploading()}
				onClick={uploadTrack}
				class="flex flex-col gap-1.5 justify-center items-center p-4 w-full text-center rounded-xl border border-dashed transition-colors bg-gray-2 border-gray-5 hover:bg-gray-3 hover:border-gray-7 disabled:opacity-60"
			>
				<span class="flex justify-center items-center mb-0.5 rounded-full size-9 bg-gray-3 text-gray-11">
					<Show
						when={!uploading()}
						fallback={
							<div class="rounded-full border-2 animate-spin size-4 border-gray-6 border-t-gray-11" />
						}
					>
						<IconLucideUpload class="size-4" />
					</Show>
				</span>
				<span class="text-[13px] font-medium text-gray-12">
					{uploading() ? "Importing…" : "Upload your own"}
				</span>
				<span class="text-[11px] text-gray-9">
					MP3, WAV, M4A, OGG, FLAC, AAC
				</span>
			</button>
		</div>
	);
}
