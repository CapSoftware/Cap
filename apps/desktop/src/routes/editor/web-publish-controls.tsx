import { Channel, invoke } from "@tauri-apps/api/core";
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
import { trackEvent } from "~/utils/analytics";
import IconLucideCheck from "~icons/lucide/check";
import IconLucideDownload from "~icons/lucide/download";
import { useEditorContext } from "./context";
import { EditorButton } from "./ui";

type SaveStatus = {
	state: "idle" | "rendering" | "ready" | "error";
	exportId: string | null;
	progress: number;
	playable: boolean;
	hlsUrl: string | null;
	error: string | null;
	/** The share link shows, or is rendering, the project as saved now. */
	current?: boolean;
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
// A farm render that shows no progress for this long is treated as stuck and
// the save renders in the browser instead.
const FARM_STALL_MS = 90_000;
// Opened straight from the recorder: the recording publishes in its default
// style without waiting for a Save when nothing is rendering it yet.
const publishOnOpen =
	new URLSearchParams(window.location.search).get("publish") === "recording";

export function WebPublishControls() {
	const {
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
	// The revision this session last saved. Nothing counts as saved until a
	// Save, unless the share link already shows the project as it was opened.
	const [savedRevision, setSavedRevision] = createSignal<number | null>(null);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;
	// The farm save this editor started, watched so a failed or stuck render
	// falls back to rendering in the browser.
	let farmSave: { progress: number; progressAt: number } | null = null;

	const poll = async (
		resuming = false,
	): Promise<SaveStatus["state"] | undefined> => {
		clearTimeout(timer);
		try {
			const next = await invoke<SaveStatus>("webEditorSaveStatus");
			if (disposed) return next.state;
			if (resuming && next.current) {
				setSavedRevision(0);
				setStatus(next);
			}
			if (resuming && next.state !== "rendering") return next.state;
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
		try {
			await invoke("webEditorSaveInBrowser", {
				channel: new Channel<BrowserSaveProgress>((progress) => {
					if (!disposed) setBrowserSave(progress);
				}),
			});
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
	const hasUnsavedEdits = () => projectRevision() !== savedRevision();
	const upToDate = () =>
		!hasUnsavedEdits() && !rendering() && status()?.state === "ready";

	// The page asks before closing while this session has edits its share link
	// doesn't show yet: not saved, still rendering in this tab, or failed.
	const unpublishedEdits = () =>
		projectRevision() !== (savedRevision() ?? 0) ||
		browserSave() !== null ||
		status()?.state === "error";
	const editorWindow = window as Window & {
		capWebEditorUnpublishedEdits?: () => boolean;
	};
	editorWindow.capWebEditorUnpublishedEdits = unpublishedEdits;
	onCleanup(() => {
		if (editorWindow.capWebEditorUnpublishedEdits === unpublishedEdits)
			delete editorWindow.capWebEditorUnpublishedEdits;
	});

	const save = async (automatic = false) => {
		if (starting() || rendering()) return;
		setStarting(true);
		try {
			// Save renders the stored project, so edits still debouncing land first.
			await flushProjectConfig();
			const revision = projectRevision();
			const started = await invoke<SaveStart>("webEditorSave");
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
			if (automatic)
				console.warn("Cap could not publish the recording:", message);
			else toast.error(message);
		} finally {
			setStarting(false);
		}
	};

	// Both can render on this device, so the renderer starts loading as soon
	// as the person reaches for either.
	const prewarmExport = () => {
		void invoke("webEditorPrewarmExport").catch(() => undefined);
	};

	const openDownload = () => {
		setEditorState("timeline", "selection", null);
		trackEvent("export_button_clicked");
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
					disabled={starting() || rendering() || upToDate()}
					onClick={() => void save()}
					onPointerEnter={prewarmExport}
					onFocus={prewarmExport}
					class={cx(
						"relative flex h-[30px] min-w-[84px] shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-lg px-3.5 text-[13px] font-medium outline-hidden transition-[filter,background-color,color] duration-150",
						upToDate()
							? "bg-ed-ctl text-ed-text-2 hover:bg-ed-ctl-hover"
							: "bg-linear-to-b from-ed-accent-2 to-ed-accent text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_1px_2px_rgba(0,60,160,0.25)] hover:brightness-[1.06] active:brightness-[0.96] disabled:cursor-default disabled:hover:brightness-100",
					)}
				>
					<Show when={browserSave() ?? (rendering() && status()?.playable)}>
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
								{status()?.playable
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
