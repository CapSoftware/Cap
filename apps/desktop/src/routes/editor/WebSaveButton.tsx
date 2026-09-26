import { invoke } from "@tauri-apps/api/core";
import {
	createSignal,
	Match,
	onCleanup,
	onMount,
	Show,
	Switch,
} from "solid-js";
import toast from "solid-toast";
import { EditorButton } from "./ui";

type SaveStatus = {
	state: "idle" | "rendering" | "ready" | "error";
	exportId: string | null;
	progress: number;
	playable: boolean;
	hlsUrl: string | null;
	error: string | null;
};

const POLL_MS = 2000;

export default function WebSaveButton(props: { shareUrl?: string }) {
	const [starting, setStarting] = createSignal(false);
	const [status, setStatus] = createSignal<SaveStatus | null>(null);
	const [shareUrl, setShareUrl] = createSignal(props.shareUrl ?? null);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;

	const poll = async (resuming = false) => {
		clearTimeout(timer);
		try {
			const next = await invoke<SaveStatus>("webEditorSaveStatus");
			if (disposed || (resuming && next.state !== "rendering")) return;
			setStatus(next);
			if (next.state === "rendering") timer = setTimeout(poll, POLL_MS);
			else if (next.state === "error") toast.error(next.error ?? "Save failed");
		} catch {
			if (!disposed && !resuming) timer = setTimeout(poll, POLL_MS * 2);
		}
	};

	onMount(() => {
		void poll(true);
	});
	onCleanup(() => {
		disposed = true;
		clearTimeout(timer);
	});

	const save = async () => {
		if (starting()) return;
		setStarting(true);
		try {
			const result = await invoke<{ shareUrl: string }>("webEditorSave");
			setShareUrl(result.shareUrl);
			setStatus({
				state: "rendering",
				exportId: null,
				progress: 0,
				playable: false,
				hlsUrl: null,
				error: null,
			});
			timer = setTimeout(poll, POLL_MS);
		} catch (cause) {
			toast.error(cause instanceof Error ? cause.message : "Save failed");
		} finally {
			setStarting(false);
		}
	};

	const rendering = () => status()?.state === "rendering";
	const percent = () => Math.floor((status()?.progress ?? 0) * 100);

	return (
		<div class="flex shrink-0 items-center gap-2">
			<Show
				when={shareUrl() && (status()?.playable || status()?.state === "ready")}
			>
				<a
					href={shareUrl() ?? undefined}
					target="_blank"
					rel="noopener noreferrer"
					class="text-[13px] font-medium text-ed-accent hover:underline"
				>
					{rendering() ? "Watch now" : "View"}
				</a>
			</Show>
			<EditorButton
				variant="text"
				disabled={starting() || rendering()}
				tooltipText={
					status()?.state === "error"
						? (status()?.error ?? "Save failed")
						: "Publish your edits to the share link"
				}
				onClick={() => void save()}
			>
				<Switch fallback="Save">
					<Match when={starting()}>Saving…</Match>
					<Match when={rendering()}>
						{status()?.playable ? `Rendering ${percent()}%` : "Preparing…"}
					</Match>
					<Match when={status()?.state === "ready"}>Saved</Match>
					<Match when={status()?.state === "error"}>Retry save</Match>
				</Switch>
			</EditorButton>
		</div>
	);
}
