import { Popover as KPopover } from "@kobalte/core/popover";
import { Channel, invoke } from "@tauri-apps/api/core";
import { cx } from "cva";
import {
	createMemo,
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
import IconLucideCopy from "~icons/lucide/copy";
import IconLucideDownload from "~icons/lucide/download";
import IconLucideExternalLink from "~icons/lucide/external-link";
import IconLucideGlobe from "~icons/lucide/globe";
import IconLucideLink from "~icons/lucide/link";
import { useEditorContext } from "./context";
import { EditorButton } from "./ui";

type SaveStatus = {
	state: "idle" | "rendering" | "ready" | "error";
	exportId: string | null;
	progress: number;
	playable: boolean;
	hlsUrl: string | null;
	error: string | null;
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

/**
 * The web editor's publishing controls. The recording already lives at a share
 * link, so Save publishes these edits to that link and Download renders a
 * file on this computer.
 */
export function WebPublishControls() {
	const {
		meta,
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
	// The revision this session last saved; edits from before the editor opened
	// may or may not be published, so nothing counts as saved until a Save.
	const [savedRevision, setSavedRevision] = createSignal<number | null>(null);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;
	// The farm save this editor started, watched so a failed or stuck render
	// falls back to rendering in the browser.
	let farmSave: { progress: number; progressAt: number } | null = null;

	const poll = async (resuming = false) => {
		clearTimeout(timer);
		try {
			const next = await invoke<SaveStatus>("webEditorSaveStatus");
			if (disposed || (resuming && next.state !== "rendering")) return;
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

	onMount(() => void poll(true));
	onCleanup(() => {
		disposed = true;
		clearTimeout(timer);
	});

	const rendering = () =>
		status()?.state === "rendering" || browserSave() !== null;
	const hasUnsavedEdits = () => projectRevision() !== savedRevision();
	const upToDate = () =>
		!hasUnsavedEdits() && !rendering() && status()?.state === "ready";

	const save = async () => {
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
			toast.error(cause instanceof Error ? cause.message : "Save failed");
		} finally {
			setStarting(false);
		}
	};

	const openDownload = () => {
		setEditorState("timeline", "selection", null);
		trackEvent("export_button_clicked");
		if (exportState.type === "done") setExportState({ type: "idle" });
		setDialog({ type: "export", open: true });
	};

	return (
		<div class="flex shrink-0 items-center gap-1.5">
			<Show when={meta().sharing}>
				{(sharing) => (
					<ShareMenu
						url={sharing().link}
						hasUnsavedEdits={hasUnsavedEdits() || rendering()}
					/>
				)}
			</Show>
			<EditorButton
				variant="text"
				tooltipText="Render a video file to your computer"
				leftIcon={<IconLucideDownload class="size-4" />}
				onClick={openDownload}
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
					disabled={starting() || rendering()}
					onClick={() => void save()}
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

function ShareMenu(props: { url: string; hasUnsavedEdits: boolean }) {
	const [copied, setCopied] = createSignal(false);
	let copiedTimer: ReturnType<typeof setTimeout> | undefined;
	onCleanup(() => clearTimeout(copiedTimer));
	const displayUrl = createMemo(() => {
		const url = new URL(props.url);
		return `${url.host}${url.pathname}`;
	});

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(props.url);
			setCopied(true);
			clearTimeout(copiedTimer);
			copiedTimer = setTimeout(() => setCopied(false), 1800);
		} catch {
			toast.error("Could not copy the link");
		}
	};

	return (
		<KPopover placement="bottom-end" gutter={8} flip fitViewport>
			<EditorButton<typeof KPopover.Trigger>
				as={KPopover.Trigger}
				variant="text"
				tooltipText="Share link"
				leftIcon={<IconLucideLink class="size-4" />}
			>
				<span class="max-[1100px]:hidden">Share</span>
			</EditorButton>
			<KPopover.Portal>
				<KPopover.Content
					class={cx(
						"z-60 flex w-[min(22rem,calc(100vw-1.5rem))] flex-col gap-3 rounded-2xl bg-ed-card p-3 shadow-ed-pop outline-hidden",
						"origin-[var(--kb-popover-content-transform-origin)] data-expanded:animate-in data-expanded:fade-in data-expanded:zoom-in-95 data-closed:animate-out data-closed:fade-out data-closed:zoom-out-95",
					)}
				>
					<div class="flex items-center gap-2.5 px-0.5">
						<span class="flex size-8 shrink-0 items-center justify-center rounded-full bg-ed-accent/12 text-ed-accent">
							<IconLucideGlobe class="size-4" />
						</span>
						<div class="flex min-w-0 flex-col">
							<KPopover.Title class="text-[13px] font-medium text-ed-text-1">
								Your share link
							</KPopover.Title>
							<KPopover.Description class="text-[12px] text-ed-text-2">
								{props.hasUnsavedEdits
									? "Viewers see your last save. Save to show these edits."
									: "Viewers see this version."}
							</KPopover.Description>
						</div>
					</div>
					<div class="flex h-9 items-center gap-1 rounded-[10px] bg-ed-ctl pl-3 pr-1">
						<span
							data-selectable-text
							class="min-w-0 flex-1 truncate text-[13px] text-ed-text-1"
						>
							{displayUrl()}
						</span>
						<button
							type="button"
							onClick={() => void copy()}
							class="flex h-7 shrink-0 items-center gap-1.5 rounded-[7px] bg-ed-accent px-2.5 text-[12px] font-medium text-white outline-hidden transition-[filter] hover:brightness-[1.06]"
						>
							<Show
								when={copied()}
								fallback={<IconLucideCopy class="size-3.5" />}
							>
								<IconLucideCheck class="size-3.5" />
							</Show>
							{copied() ? "Copied" : "Copy link"}
						</button>
					</div>
					<a
						href={props.url}
						target="_blank"
						rel="noopener noreferrer"
						class="flex items-center gap-1.5 self-start rounded-md px-0.5 text-[12px] font-medium text-ed-accent hover:underline"
					>
						Open share page
						<IconLucideExternalLink class="size-3.5" />
					</a>
				</KPopover.Content>
			</KPopover.Portal>
		</KPopover>
	);
}
