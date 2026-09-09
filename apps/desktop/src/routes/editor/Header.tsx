import { ask } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { type as ostype } from "@tauri-apps/plugin-os";
import { cx } from "cva";
import {
	type ComponentProps,
	createEffect,
	createMemo,
	createSignal,
	on,
	onCleanup,
	Show,
} from "solid-js";
import toast from "solid-toast";
import Tooltip from "~/components/Tooltip";
import CaptionControlsMacOS from "~/components/titlebar/controls/CaptionControlsMacOS";
import CaptionControlsWindows11 from "~/components/titlebar/controls/CaptionControlsWindows11";
import { trackEvent } from "~/utils/analytics";
import { commands } from "~/utils/tauri";
import { useEditorContext } from "./context";
import OrganizationDropdown from "./OrganizationDropdown";
import PresetsDropdown from "./PresetsDropdown";
import { createRecordingTitleSave } from "./recording-title-save";
import ShareButton from "./ShareButton";
import { EditorButton } from "./ui";

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

export function Header(props: { registerTitleSave: RegisterTitleSave }) {
	const {
		editorInstance,
		project,
		projectHistory,
		dialog,
		setDialog,
		meta,
		exportState,
		setExportState,
		customDomain,
		editorState,
		setEditorState,
	} = useEditorContext();

	const clearTimelineSelection = () => {
		if (!editorState.timeline.selection) return false;
		setEditorState("timeline", "selection", null);
		return true;
	};

	const hasTranscript = createMemo(() => {
		const segments = project.captions?.segments ?? [];
		return segments.some((seg) => seg.words && seg.words.length > 0);
	});

	const isTranscriptOpen = createMemo(() => {
		const d = dialog();
		return "type" in d && d.type === "transcript" && d.open;
	});

	const isClipsOpen = createMemo(() => {
		const d = dialog();
		return "type" in d && d.type === "clips" && d.open;
	});

	const [titleReadOnly, setTitleReadOnly] = createSignal(false);

	return (
		<div
			data-tauri-drag-region
			class="flex relative shrink-0 flex-row items-center w-full h-13 pr-3 max-[900px]:grid max-[900px]:grid-cols-1 max-[900px]:grid-rows-[36px_36px] max-[900px]:h-[72px] max-[900px]:pr-2"
		>
			<div
				data-tauri-drag-region
				class={cx(
					"flex flex-row flex-1 min-w-0 items-center h-full",
					ostype() === "windows" && "max-[900px]:pr-[146px]",
				)}
			>
				{ostype() === "macos" && (
					<div data-tauri-drag-region class="h-full w-[92px] shrink-0" />
				)}
				{ostype() === "linux" && (
					<CaptionControlsMacOS class="mr-1 ml-3 shrink-0" />
				)}
				{ostype() === "windows" && <div class="w-3 shrink-0" />}

				<div class="flex gap-1.5 items-center min-w-0">
					<NameEditor
						name={meta().prettyName}
						registerTitleSave={props.registerTitleSave}
						readOnly={titleReadOnly()}
						setReadOnly={setTitleReadOnly}
					/>
					<span class="shrink-0 text-[13px] text-ed-text-3">.cap</span>
				</div>

				<div class="flex gap-0.5 items-center ml-1.5 shrink-0">
					<EditorButton
						onClick={() => {
							clearTimelineSelection();

							console.log({ path: `${editorInstance.path}/` });
							revealItemInDir(`${editorInstance.path}/`);
						}}
						tooltipText="Open recording bundle"
						leftIcon={<IconLucideFolder />}
					/>
					<EditorButton
						onClick={async () => {
							clearTimelineSelection();

							if (
								!(await ask("Are you sure you want to delete this recording?"))
							)
								return;

							await commands.editorDeleteProject();
						}}
						tooltipText="Delete recording"
						leftIcon={<IconCapTrash />}
					/>
				</div>

				<div data-tauri-drag-region class="flex-1 h-full min-w-2" />
			</div>

			<div
				data-tauri-drag-region
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
				<OrganizationDropdown />
				<PresetsDropdown />
				<EditorButton
					title="Clips"
					aria-label="Clips"
					class={cx(isClipsOpen() && "bg-ed-ctl-hover text-ed-text-1")}
					leftIcon={<IconCapClapperboard />}
					onClick={() => {
						clearTimelineSelection();
						if (isClipsOpen()) {
							setDialog((d) => ({ ...d, open: false }));
						} else {
							setDialog({ type: "clips", open: true });
						}
					}}
				>
					<span class="max-[1200px]:hidden">Clips</span>
				</EditorButton>
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
				<Show when={customDomain.data}>
					<ShareButton />
				</Show>
				<button
					type="button"
					class={cx(
						"flex shrink-0 gap-[7px] justify-center items-center pl-3 pr-3.5 ml-1.5 h-[30px] text-[13px] font-medium text-white rounded-lg outline-hidden",
						"bg-linear-to-b from-ed-accent-2 to-ed-accent",
						"shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_1px_2px_rgba(0,60,160,0.25)]",
						"transition-[filter] duration-150 ease-out",
						"hover:brightness-[1.06] active:brightness-[0.96]",
					)}
					onClick={() => {
						clearTimelineSelection();

						trackEvent("export_button_clicked");
						if (exportState.type === "done") setExportState({ type: "idle" });

						setDialog({ type: "export", open: true });
					}}
				>
					<UploadIcon class="size-4" />
					Export
				</button>
			</div>
			{ostype() === "windows" && (
				<CaptionControlsWindows11 class="shrink-0 max-[900px]:absolute max-[900px]:right-0 max-[900px]:top-0 max-[900px]:h-9" />
			)}
		</div>
	);
}

const UploadIcon = (props: ComponentProps<"svg">) => {
	const { exportState } = useEditorContext();
	return (
		<svg
			width={20}
			height={20}
			viewBox="0 0 20 20"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			{...props}
		>
			{/* Bottom part (the base) */}
			<path
				d="M16.6667 10.625V14.1667C16.6667 15.5474 15.5474 16.6667 14.1667 16.6667H5.83333C4.45262 16.6667 3.33333 15.5474 3.33333 14.1667V10.625"
				stroke="currentColor"
				stroke-width={1.66667}
				stroke-linecap="round"
				stroke-linejoin="round"
				class="upload-base"
			/>

			{/* Arrow part */}
			<path
				d="M9.99999 3.33333V12.7083M9.99999 3.33333L13.75 7.08333M9.99999 3.33333L6.24999 7.08333"
				stroke="currentColor"
				stroke-width={1.66667}
				stroke-linecap="round"
				stroke-linejoin="round"
				class={cx(
					exportState.type !== "idle" &&
						exportState.type !== "done" &&
						"bounce",
				)}
			/>
		</svg>
	);
};

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
					class="pointer-events-none max-w-[200px] px-px m-0 peer-focus:opacity-0 border-b border-transparent truncate whitespace-pre"
				>
					{prettyName()}
				</span>
			</div>
		</Tooltip>
	);
}
