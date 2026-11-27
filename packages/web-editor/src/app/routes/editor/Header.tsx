import { createEventListener } from "@solid-primitives/event-listener";
import { cx } from "cva";
import {
	createEffect,
	createMemo,
	createSignal,
	lazy,
	on,
	onCleanup,
	Show,
	Suspense,
} from "solid-js";
import toast from "solid-toast";
import Tooltip from "~/components/Tooltip";
import IconLucideSwatchBook from "~icons/lucide/swatch-book";
import { commands } from "../../../engine/editor-api";
import { useEditorContext } from "./context";
import { createRecordingTitleSave } from "./recording-title-save";
import { EditorButton } from "./ui";
import { WebPublishControls } from "./web-publish-controls";

const TemplatesGallery = lazy(() =>
	import("./templates-gallery").then((m) => ({ default: m.TemplatesGallery })),
);

export type ResolutionOption = {
	label: string;
	value: string;
	width: number;
	height: number;
};

export const RESOLUTION_OPTIONS = {
	_720p: { label: "720p", value: "720p", width: 1280, height: 720 },
	_1080p: { label: "1080p", value: "1080p", width: 1920, height: 1080 },
	_4k: { label: "4K", value: "4k", width: 3840, height: 2160 },
};

export interface ExportEstimates {
	duration_seconds: number;
	estimated_time_seconds: number;
	estimated_size_mb: number;
}

export type TitleSaveRegistration = {
	flush: () => Promise<void>;
	setReadOnly: (readOnly: boolean) => void;
};

type RegisterTitleSave = (save: TitleSaveRegistration | undefined) => void;
const captionsAllowed = () =>
	(window as Window & { capWebEditorCaptionsEnabled?: boolean })
		.capWebEditorCaptionsEnabled === true;

export function Header(props: {
	registerTitleSave: RegisterTitleSave;
	disabled?: boolean;
}) {
	const {
		project,
		projectHistory,
		dialog,
		setDialog,
		meta,
		editorState,
		setEditorState,
	} = useEditorContext();

	const clearTimelineSelection = () => {
		if (!editorState.timeline.selection) return false;
		setEditorState("timeline", "selection", null);
		return true;
	};
	const [captionPlanAllowed, setCaptionPlanAllowed] = createSignal(
		captionsAllowed(),
	);
	createEventListener(window, "cap-web-editor-captions-plan", () =>
		setCaptionPlanAllowed(captionsAllowed()),
	);

	const hasTranscript = createMemo(() => {
		const segments = project.captions?.segments ?? [];
		return (
			captionPlanAllowed() &&
			segments.some((seg) => seg.words && seg.words.length > 0)
		);
	});

	const isTranscriptOpen = createMemo(() => {
		const d = dialog();
		return "type" in d && d.type === "transcript" && d.open;
	});

	const [titleReadOnly, setTitleReadOnly] = createSignal(false);

	return (
		<div
			data-editor-header
			class="flex relative shrink-0 flex-row items-center w-full h-13 pr-3 max-[900px]:grid max-[900px]:grid-cols-1 max-[900px]:grid-rows-[36px_36px] max-[900px]:h-[72px] max-[900px]:pr-2"
		>
			<div class="flex flex-row flex-1 min-w-0 items-center h-full">
				<div class="w-3 shrink-0" />

				<div inert={props.disabled} class="flex gap-1.5 items-center min-w-0">
					<NameEditor
						name={meta().prettyName}
						registerTitleSave={props.registerTitleSave}
						readOnly={titleReadOnly() || props.disabled === true}
						setReadOnly={setTitleReadOnly}
					/>
					<span
						data-header-extension
						class="shrink-0 text-[13px] text-ed-text-3"
					>
						.cap
					</span>
				</div>

				<div
					inert={props.disabled}
					data-header-delete
					class="flex gap-0.5 items-center ml-1.5 shrink-0"
				>
					<EditorButton
						onClick={async () => {
							clearTimelineSelection();

							if (
								!window.confirm(
									"Are you sure you want to delete this recording?",
								)
							)
								return;

							await commands.editorDeleteProject();
						}}
						tooltipText="Delete recording"
						leftIcon={<IconCapTrash />}
					/>
				</div>

				<div class="flex-1 h-full min-w-2" />
			</div>

			<div
				data-header-actions
				inert={props.disabled}
				class="flex shrink-0 flex-row items-center gap-1 max-[900px]:justify-end"
			>
				<EditorButton
					onClick={() => {
						clearTimelineSelection();
						if (!projectHistory.canUndo()) return;
						projectHistory.undo();
					}}
					disabled={
						!projectHistory.canUndo() && !editorState.timeline.selection
					}
					tooltipText="Undo"
					leftIcon={<IconCapUndo />}
				/>
				<EditorButton
					onClick={() => {
						clearTimelineSelection();
						if (!projectHistory.canRedo()) return;
						projectHistory.redo();
					}}
					disabled={
						!projectHistory.canRedo() && !editorState.timeline.selection
					}
					tooltipText="Redo"
					leftIcon={<IconCapRedo />}
				/>
				<div class="mx-1.5 w-px h-4 shrink-0 bg-ed-line-strong" />
				<Suspense
					fallback={
						<EditorButton
							disabled
							leftIcon={<IconLucideSwatchBook class="size-4" />}
						>
							<span class="max-[1200px]:hidden">Presets</span>
						</EditorButton>
					}
				>
					<TemplatesGallery />
				</Suspense>
				<Show when={hasTranscript()}>
					<EditorButton
						title={isTranscriptOpen() ? "Back to editor" : "Captions"}
						aria-label={isTranscriptOpen() ? "Back to editor" : "Captions"}
						class={cx(isTranscriptOpen() && "bg-ed-ctl-hover text-ed-text-1")}
						leftIcon={
							<Show when={isTranscriptOpen()} fallback={<IconCapCaptions />}>
								<IconLucideArrowLeft />
							</Show>
						}
						onClick={() => {
							clearTimelineSelection();
							if (isTranscriptOpen()) {
								setDialog((d) => ({ ...d, open: false }));
							} else {
								setDialog({ type: "transcript", open: true });
							}
						}}
					>
						<span class="max-[1200px]:hidden">
							{isTranscriptOpen() ? "Back" : "Captions"}
						</span>
					</EditorButton>
				</Show>
				<WebPublishControls />
			</div>
		</div>
	);
}

function NameEditor(props: {
	name: string;
	registerTitleSave: RegisterTitleSave;
	readOnly: boolean;
	setReadOnly: (readOnly: boolean) => void;
}) {
	const { refetchMeta } = useEditorContext();

	let prettyNameRef: HTMLInputElement | undefined;
	let prettyNameMeasureRef: HTMLSpanElement | undefined;
	const [truncated, setTruncated] = createSignal(false);
	const [prettyName, setPrettyName] = createSignal(props.name);
	const flushPrettyName = createRecordingTitleSave({
		initialName: props.name,
		getDraft: prettyName,
		resetDraft: setPrettyName,
		save: async (trimmed) => {
			try {
				await commands.setPrettyName(trimmed);
				void refetchMeta();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				toast.error(`Failed to save recording title: ${message}`);
				throw error;
			}
		},
	});
	props.registerTitleSave({
		flush: flushPrettyName,
		setReadOnly: props.setReadOnly,
	});
	onCleanup(() => props.registerTitleSave(undefined));

	createEffect(
		on(prettyName, () => {
			const frame = requestAnimationFrame(() => {
				if (!prettyNameMeasureRef) return;
				setTruncated(
					prettyNameMeasureRef.scrollWidth > prettyNameMeasureRef.clientWidth,
				);
			});
			onCleanup(() => cancelAnimationFrame(frame));
		}),
	);

	return (
		<Tooltip content={props.name} childClass="min-w-0">
			<div class="flex relative flex-row items-center min-w-0 text-[13px] font-medium tracking-[-0.01em] text-ed-text-1">
				<input
					ref={prettyNameRef}
					class={cx(
						"absolute inset-0 px-px m-0 opacity-0 overflow-hidden focus:opacity-100 bg-transparent border-b border-transparent focus:border-ed-line-strong focus:outline-hidden peer whitespace-pre select-text",
						truncated() && "truncate",
						(prettyName().length < 5 || prettyName().length > 100) &&
							"focus:border-red-500",
					)}
					value={prettyName()}
					readOnly={props.readOnly}
					onInput={(e) => setPrettyName(e.currentTarget.value)}
					onBlur={() => {
						void flushPrettyName().catch(() => {});
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === "Escape") {
							prettyNameRef?.blur();
						}
					}}
				/>
				<span
					ref={prettyNameMeasureRef}
					class="pointer-events-none max-w-[480px] px-px m-0 peer-focus:opacity-0 border-b border-transparent truncate whitespace-pre"
				>
					{prettyName()}
				</span>
			</div>
		</Tooltip>
	);
}
