import { cx } from "cva";
import {
	createSignal,
	Match,
	onCleanup,
	onMount,
	Show,
	Switch,
} from "solid-js";
import toast from "solid-toast";
import Tooltip from "~/components/Tooltip";
import IconLucideCheck from "~icons/lucide/check";
import IconLucideDownload from "~icons/lucide/download";
import {
	commands,
	EditorChannel,
	hostCommand,
} from "../../../engine/editor-api";
import { useEditorContext } from "./context";
import { getPreviewProjectConfig } from "./preview-config";
import { EditorButton } from "./ui";
import { shareLinkShowsProject } from "./web-save-state";

type SaveStatus = {
	state: "idle" | "rendering" | "ready" | "error";
	exportId: string | null;
	progress: number;
	playable: boolean;
	hlsUrl: string | null;
	error: string | null;
	current?: boolean;
	inBrowser?: boolean;
};

type SaveStart =
	| { renderer: "farm"; shareUrl: string }
	| { renderer: "browser"; reason: string };

type BrowserSaveProgress = {
	stage: "rendering" | "uploading";
	progress: number;
};

const POLL_MS = 2000;
const FIRST_POLL_MS = 1000;
const FARM_STALL_MS = 90_000;
const publishOnOpen =
	new URLSearchParams(window.location.search).get("publish") === "recording";

export function WebPublishControls() {
	const {
		project,
		editorState,
		flushProjectConfig,
		projectRevision,
		exportState,
		setExportState,
		setDialog,
		setEditorState,
	} = useEditorContext();
	const [starting, setStarting] = createSignal(false);
	const [status, setStatus] = createSignal<SaveStatus | null>(null);
	const [browserSave, setBrowserSave] =
		createSignal<BrowserSaveProgress | null>(null);
	const [linkCurrent, setLinkCurrent] = createSignal(false);
	const [savedRevision, setSavedRevision] = createSignal<number | null>(null);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;
	let farmSave: { progress: number; progressAt: number } | null = null;

	const poll = async (
		resuming = false,
	): Promise<SaveStatus["state"] | undefined> => {
		clearTimeout(timer);
		try {
			const next = await hostCommand<SaveStatus>("webEditorSaveStatus");
			if (disposed) return next.state;
			if (resuming && shareLinkShowsProject(next)) {
				setSavedRevision(0);
				setLinkCurrent(true);
				setStatus(next);
			}
			if (resuming && next.state !== "rendering") return next.state;
			// A tab that was closed mid-save leaves it rendering until it goes
			// stale. A freshly opened editor isn't the tab rendering it, so its
			// Save stays available and replaces that save.
			if (resuming && next.inBrowser) return "idle";
			// A farm save still rendering when the editor opens gets the same
			// stall check as one this tab started.
			if (resuming && !farmSave) {
				farmSave = { progress: next.progress, progressAt: Date.now() };
			}
			if (farmSave && !resuming) {
				const now = Date.now();
				if (next.progress > farmSave.progress || next.playable) {
					farmSave = { progress: next.progress, progressAt: now };
				}
				if (
					next.state === "error" ||
					(next.state === "rendering" &&
						!next.playable &&
						now - farmSave.progressAt > FARM_STALL_MS)
				) {
					farmSave = null;
					console.warn(
						"Cap save renders in this browser:",
						next.error ?? "the render farm stopped making progress",
					);
					setSavedRevision(projectRevision());
					await saveInBrowser();
					return;
				}
			}
			setStatus(next);
			if (next.state === "rendering") timer = setTimeout(poll, POLL_MS);
			else {
				farmSave = null;
				if (next.state === "error" && !resuming)
					toast.error(next.error ?? "Save failed");
			}
			return next.state;
		} catch {
			if (!disposed && !resuming) timer = setTimeout(poll, POLL_MS * 2);
		}
	};

	const saveInBrowser = async () => {
		setStatus(null);
		setBrowserSave({ stage: "rendering", progress: 0 });
		// The browser render reads the project the preview holds, which the
		// editor only hands over after the first edit. A save resumed from a
		// stalled farm render can start before any edit, so hand it over here.
		await commands
			.updateProjectConfigInMemory(
				getPreviewProjectConfig(project, editorState),
				null,
				null,
				null,
			)
			.catch(() => undefined);
		const channel = new EditorChannel<BrowserSaveProgress>((progress) => {
			if (!disposed) setBrowserSave(progress);
		});
		try {
			await hostCommand("webEditorSaveInBrowser", { channel });
			if (disposed) return;
			setStatus({
				state: "ready",
				exportId: null,
				progress: 1,
				playable: false,
				hlsUrl: null,
				error: null,
			});
		} catch (cause) {
			if (disposed) return;
			const error = cause instanceof Error ? cause.message : "Save failed";
			setStatus({
				state: "error",
				exportId: null,
				progress: 0,
				playable: false,
				hlsUrl: null,
				error,
			});
			toast.error(error);
		} finally {
			channel.close();
			setBrowserSave(null);
		}
	};

	onMount(() => {
		void poll(true).then((state) => {
			if (publishOnOpen && state === "idle") void save(true);
		});
	});
	onCleanup(() => {
		disposed = true;
		clearTimeout(timer);
	});

	const rendering = () =>
		status()?.state === "rendering" || browserSave() !== null;
	const showsProgress = () =>
		!!status()?.playable || (status()?.progress ?? 0) > 0;
	const hasUnsavedEdits = () => projectRevision() !== savedRevision();
	const upToDate = () =>
		!hasUnsavedEdits() &&
		!rendering() &&
		(status()?.state === "ready" || linkCurrent());

	const unpublishedEdits = () =>
		projectRevision() !== (savedRevision() ?? 0) ||
		browserSave() !== null ||
		status()?.state === "error";
	const savingHere = () => starting() || browserSave() !== null;
	const editorWindow = window as Window & {
		capWebEditorUnpublishedEdits?: () => boolean;
		capWebEditorSavingHere?: () => boolean;
	};
	editorWindow.capWebEditorUnpublishedEdits = unpublishedEdits;
	editorWindow.capWebEditorSavingHere = savingHere;
	onCleanup(() => {
		if (editorWindow.capWebEditorUnpublishedEdits === unpublishedEdits)
			delete editorWindow.capWebEditorUnpublishedEdits;
		if (editorWindow.capWebEditorSavingHere === savingHere)
			delete editorWindow.capWebEditorSavingHere;
	});

	const save = async (automatic = false) => {
		if (starting() || rendering()) return;
		setStarting(true);
		setLinkCurrent(false);
		try {
			await flushProjectConfig();
			const revision = projectRevision();
			const started = await hostCommand<SaveStart>("webEditorSave");
			setSavedRevision(revision);
			if (started.renderer === "browser") {
				console.info("Cap save renders in this browser:", started.reason);
				setStarting(false);
				await saveInBrowser();
				return;
			}
			farmSave = { progress: 0, progressAt: Date.now() };
			setStatus({
				state: "rendering",
				exportId: null,
				progress: 0,
				playable: false,
				hlsUrl: null,
				error: null,
			});
			timer = setTimeout(poll, FIRST_POLL_MS);
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : "Save failed";
			if (automatic) {
				console.warn("Cap could not publish the recording:", message);
				return;
			}
			setStatus({
				state: "error",
				exportId: null,
				progress: 0,
				playable: false,
				hlsUrl: null,
				error: message,
			});
			toast.error(message);
		} finally {
			setStarting(false);
		}
	};

	const prewarmExport = () => {
		void hostCommand("webEditorPrewarmExport").catch(() => undefined);
	};

	const openDownload = () => {
		setEditorState("timeline", "selection", null);
		if (exportState.type === "done") setExportState({ type: "idle" });
		setDialog({ type: "export", open: true });
	};

	return (
		<div class="flex shrink-0 items-center gap-1.5">
			<EditorButton
				variant="text"
				tooltipText="Render a video file to your computer"
				leftIcon={<IconLucideDownload class="size-4" />}
				onClick={openDownload}
				onPointerEnter={prewarmExport}
				onFocus={prewarmExport}
			>
				<span class="max-[1100px]:hidden">Download</span>
			</EditorButton>
			<Tooltip
				content={
					browserSave()
						? "Rendering on this device. Keep this tab open until it finishes."
						: status()?.state === "error"
							? (status()?.error ?? "Save failed")
							: upToDate()
								? "Your share link shows this version"
								: "Update your share link with these edits"
				}
			>
				<button
					type="button"
					data-save-button
					disabled={starting() || rendering() || upToDate()}
					onClick={() => void save()}
					onPointerEnter={prewarmExport}
					onFocus={prewarmExport}
					class={cx(
						"relative flex h-[30px] min-w-[84px] shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-[8px] px-3.5 text-[13px] font-medium outline-hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ed-accent",
						upToDate()
							? "ed-fade bg-ed-ctl text-ed-text-2 hover:bg-ed-ctl-hover"
							: "ed-primary disabled:cursor-default",
					)}
				>
					<Show when={browserSave() ?? (rendering() && showsProgress())}>
						<span
							aria-hidden="true"
							class="absolute inset-y-0 left-0 bg-white/20 transition-[width] duration-500"
							style={{
								width: `${(browserSave()?.progress ?? status()?.progress ?? 0) * 100}%`,
							}}
						/>
					</Show>
					<span class="relative flex items-center gap-1.5">
						<Switch fallback="Save">
							<Match when={starting()}>Saving</Match>
							<Match when={browserSave()}>
								{(progress) => <span>{browserSaveLabel(progress())}</span>}
							</Match>
							<Match when={rendering()}>
								{showsProgress()
									? `Publishing ${Math.floor((status()?.progress ?? 0) * 100)}%`
									: "Publishing"}
							</Match>
							<Match when={upToDate()}>
								<IconLucideCheck class="size-3.5" />
								Saved
							</Match>
							<Match when={status()?.state === "error"}>Retry save</Match>
						</Switch>
					</span>
				</button>
			</Tooltip>
		</div>
	);
}

function browserSaveLabel({ stage, progress }: BrowserSaveProgress) {
	const percent = Math.floor(progress * 100);
	if (stage === "uploading") return `Uploading ${percent}%`;
	return percent > 0 ? `Rendering ${percent}%` : "Rendering";
}
