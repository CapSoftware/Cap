import { invoke } from "@tauri-apps/api/core";
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
	| { renderer: "worker"; reason: string };

const POLL_MS = 2000;
const FIRST_POLL_MS = 1000;
// A farm render that shows no progress for this long is treated as stuck and
// the save renders on an editor server instead.
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
	// The farm couldn't finish and an editor server took the Save over.
	const [slowSave, setSlowSave] = createSignal(false);
	// The revision this session last saved. Nothing counts as saved until a
	// Save, unless the share link already shows the project as it was opened.
	const [savedRevision, setSavedRevision] = createSignal<number | null>(null);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;
	// The farm save this editor started, watched so a failed or stuck render
	// falls back to rendering on an editor server.
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
						"Cap save renders on an editor server:",
						next.error ?? "the render farm stopped making progress",
					);
					await saveOnWorker(true);
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

	const saveOnWorker = async (slow: boolean) => {
		setSlowSave(slow);
		setStatus({
			state: "rendering",
			exportId: null,
			progress: 0,
			playable: false,
			hlsUrl: null,
			error: null,
		});
		try {
			// The Save then renders and publishes on Cap's servers like a farm
			// render, so it's followed the same way.
			await invoke("webEditorSaveOnWorker");
			if (disposed) return;
			timer = setTimeout(poll, FIRST_POLL_MS);
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

	const rendering = () => status()?.state === "rendering";
	const showsProgress = () =>
		!!status()?.playable || (status()?.progress ?? 0) > 0;
	const hasUnsavedEdits = () => projectRevision() !== savedRevision();
	const upToDate = () =>
		!hasUnsavedEdits() && !rendering() && status()?.state === "ready";

	// The page asks before closing while this session has edits its share link
	// doesn't show yet: not saved, or failed. A Save in progress carries on
	// without the tab.
	const unpublishedEdits = () =>
		projectRevision() !== (savedRevision() ?? 0) || status()?.state === "error";
	const savingHere = () => starting();
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
		try {
			// Save renders the stored project, so edits still debouncing land first.
			await flushProjectConfig();
			const revision = projectRevision();
			const started = await invoke<SaveStart>("webEditorSave");
			setSavedRevision(revision);
			if (started.renderer === "worker") {
				console.info("Cap save renders on an editor server:", started.reason);
				setStarting(false);
				await saveOnWorker(false);
				return;
			}
			setSlowSave(false);
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

	// Download renders on this device, so the renderer starts loading as soon
	// as the person reaches for it.
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
					rendering() && slowSave()
						? "Saving is taking longer than usual."
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
					class={cx(
						"relative flex h-[30px] min-w-[84px] shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-lg px-3.5 text-[13px] font-medium outline-hidden transition-[filter,background-color,color] duration-150",
						upToDate()
							? "bg-ed-ctl text-ed-text-2 hover:bg-ed-ctl-hover"
							: "bg-linear-to-b from-ed-accent-2 to-ed-accent text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_1px_2px_rgba(0,60,160,0.25)] hover:brightness-[1.06] active:brightness-[0.96] disabled:cursor-default disabled:hover:brightness-100",
					)}
				>
					<Show when={rendering() && showsProgress()}>
						<span
							aria-hidden="true"
							class="absolute inset-y-0 left-0 bg-white/20 transition-[width] duration-500"
							style={{ width: `${(status()?.progress ?? 0) * 100}%` }}
						/>
					</Show>
					<span class="relative flex items-center gap-1.5">
						<Switch fallback="Save">
							<Match when={starting()}>Saving</Match>
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
