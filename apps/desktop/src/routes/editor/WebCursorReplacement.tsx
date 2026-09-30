import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import toast from "solid-toast";
import { Toggle } from "~/components/Toggle";
import { commands } from "~/utils/tauri";
import { useEditorContext } from "./context";
import { routeEditorPlaybackIntent } from "./playback-intent-routing";
import { Field } from "./ui";

export type CursorReplacementView = {
	eligible: boolean;
	blocker: string | null;
	status: "idle" | "processing" | "ready" | "error";
	enabled: boolean;
	progress: number;
	error: string | null;
	cursorData: boolean;
};

const POLL_MS = 3000;

function endpoint() {
	const videoId = new URLSearchParams(window.location.search).get("videoId");
	return videoId && /^[A-Za-z0-9_-]{1,255}$/.test(videoId)
		? `/api/editor/videos/${encodeURIComponent(videoId)}/cursor-reconstruction`
		: null;
}

async function request(method: "GET" | "POST" | "PATCH", enabled?: boolean) {
	const url = endpoint();
	if (!url) throw new Error("This recording cannot replace its cursor");
	const response = await fetch(url, {
		method,
		credentials: "same-origin",
		cache: "no-store",
		...(enabled === undefined
			? {}
			: {
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ enabled }),
				}),
	});
	if (!response.ok) {
		throw new Error(
			response.status === 503
				? "Cursor processing is unavailable right now"
				: "Couldn't update the cursor",
		);
	}
	return (await response.json()) as CursorReplacementView;
}

/**
 * Experimental: browser recordings have their cursor burned in. Processing
 * removes it and reconstructs its path, which the editor then draws as a
 * Studio cursor; switching reloads the editor onto the other sources.
 */
export function WebCursorReplacement(props: {
	onView: (view: CursorReplacementView) => void;
}) {
	const {
		flushProjectConfig,
		editorState,
		setEditorState,
		requestHandoffPlayback,
	} = useEditorContext();
	const [view, setView] = createSignal<CursorReplacementView | null>(null);
	const [busy, setBusy] = createSignal(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;
	// Whether the sources this editor opened with had the replacement on.
	let loadedEnabled: boolean | undefined;

	const apply = (next: CursorReplacementView) => {
		loadedEnabled ??= next.enabled;
		setView(next);
		props.onView(next);
	};

	const reloadOntoSources = async () => {
		const paused = await routeEditorPlaybackIntent(
			requestHandoffPlayback,
			{ playing: false },
			async () => {
				if (editorState.playing) {
					await commands.stopPlayback();
					setEditorState("playing", false);
				}
			},
		);
		if (!paused) return false;
		await flushProjectConfig();
		window.location.reload();
		return true;
	};

	const poll = async () => {
		timer = undefined;
		try {
			const next = await request("GET");
			if (disposed) return;
			apply(next);
		} catch {
			if (disposed) return;
		}
		schedule();
	};

	const schedule = () => {
		if (!disposed && view()?.status === "processing" && !timer) {
			timer = setTimeout(poll, POLL_MS);
		}
	};

	onMount(() => void poll());
	onCleanup(() => {
		disposed = true;
		if (timer) clearTimeout(timer);
	});

	createEffect(() => {
		const current = view();
		if (
			current?.status === "ready" &&
			loadedEnabled !== undefined &&
			current.enabled !== loadedEnabled
		) {
			if (current.enabled) toast.success("Smooth cursor is ready");
			void reloadOntoSources();
		}
	});

	const toggle = async (enabled: boolean) => {
		const current = view();
		if (!current || busy()) return;
		setBusy(true);
		try {
			if (enabled && current.status !== "ready") {
				apply(await request("POST"));
				schedule();
			} else {
				apply(await request("PATCH", enabled));
			}
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Show when={view()}>
			{(current) => (
				<div class="flex flex-col gap-1.5">
					<Field inline name="Replace cursor" badge="Experimental">
						<Toggle
							checked={
								current().status === "processing" ||
								(current().status === "ready" && current().enabled)
							}
							disabled={
								busy() ||
								current().status === "processing" ||
								(!current().eligible && current().status !== "ready")
							}
							onChange={(value) => void toggle(value)}
						/>
					</Field>
					<p class="text-[11px] leading-4 text-ed-text-3">
						<Show
							when={current().status === "processing"}
							fallback={
								<Show
									when={current().status === "error"}
									fallback={
										current().blocker ??
										"Removes the recorded cursor and draws a smooth one on top."
									}
								>
									{`Processing failed: ${current().error}. Turn it on to try again.`}
								</Show>
							}
						>
							{`Processing… ${Math.round(current().progress * 100)}%`}
						</Show>
					</p>
				</div>
			)}
		</Show>
	);
}
