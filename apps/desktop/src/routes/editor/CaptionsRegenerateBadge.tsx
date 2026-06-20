import { cx } from "cva";
import { createMemo, Show } from "solid-js";
import { produce } from "solid-js/store";
import toast from "solid-toast";
import {
	applyCaptionResultToProject,
	getSelectedTranscriptionSettings,
	transcribeEditorCaptions,
} from "./captions";
import { useEditorContext } from "./context";

export function CaptionsRegenerateBadge(props: { class?: string }) {
	const { project, setProject, editorInstance, editorState, setEditorState } =
		useEditorContext();

	const showCaptionsStale = createMemo(
		() =>
			(editorState.captions.isStale || editorState.captions.isGenerating) &&
			!editorState.captions.staleDismissed &&
			((project.timeline?.captionSegments?.length ?? 0) > 0 ||
				(project.captions?.segments?.length ?? 0) > 0),
	);

	const regenerateCaptions = async () => {
		setEditorState("captions", "isGenerating", true);
		try {
			const { model, language } = getSelectedTranscriptionSettings();
			const result = await transcribeEditorCaptions(
				editorInstance.path,
				model,
				language,
			);
			if (result.segments.length < 1) {
				toast.error(
					"No captions were generated. The audio might be too quiet or unclear.",
				);
				return;
			}

			setProject(
				produce((p) => {
					applyCaptionResultToProject(
						p,
						result.segments,
						editorInstance.recordings.segments,
						editorInstance.recordingDuration,
					);
				}),
			);

			setEditorState("captions", "isStale", false);
			toast.success("Captions regenerated!");
		} catch (error) {
			console.error("Error regenerating captions:", error);
			toast.error("Failed to regenerate captions");
		} finally {
			setEditorState("captions", "isGenerating", false);
		}
	};

	return (
		<Show when={showCaptionsStale()}>
			<div
				class={cx(
					"flex items-center h-[32px] rounded-lg overflow-hidden border shadow-lg backdrop-blur bg-gray-2/95 dark:bg-gray-3/90 border-gray-4",
					props.class,
				)}
			>
				<button
					type="button"
					class="h-full px-3 text-gray-11 text-xs font-medium transition-colors hover:bg-gray-4 flex items-center gap-1.5 disabled:opacity-70 disabled:cursor-not-allowed"
					disabled={editorState.captions.isGenerating}
					onClick={() => void regenerateCaptions()}
				>
					<Show
						when={!editorState.captions.isGenerating}
						fallback={
							<svg
								class="size-3.5 animate-spin"
								viewBox="0 0 16 16"
								fill="none"
							>
								<circle
									cx="8"
									cy="8"
									r="6.5"
									stroke="currentColor"
									stroke-opacity="0.25"
									stroke-width="2.5"
								/>
								<path
									d="M14.5 8a6.5 6.5 0 00-6.5-6.5"
									stroke="currentColor"
									stroke-width="2.5"
									stroke-linecap="round"
								/>
							</svg>
						}
					>
						<IconCapCaptions class="size-3.5" />
					</Show>
					{editorState.captions.isGenerating
						? "Regenerating..."
						: "Regenerate captions"}
				</button>
				<Show when={!editorState.captions.isGenerating}>
					<div class="w-px h-4 bg-gray-6" />
					<button
						type="button"
						class="h-full w-[30px] flex items-center justify-center text-gray-9 hover:text-gray-11 hover:bg-gray-4 transition-colors"
						onClick={() => setEditorState("captions", "staleDismissed", true)}
					>
						<svg
							width="8"
							height="8"
							viewBox="0 0 10 10"
							fill="none"
							stroke="currentColor"
							stroke-width="1.5"
							stroke-linecap="round"
						>
							<path d="M1 1l8 8M9 1l-8 8" />
						</svg>
					</button>
				</Show>
			</div>
		</Show>
	);
}
