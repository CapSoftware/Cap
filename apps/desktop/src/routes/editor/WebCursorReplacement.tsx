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
// A reload that lands on the same sources again must not repeat forever.
const RELOAD_GUARD_MS = 30_000;

function videoId() {
	const id = new URLSearchParams(window.location.search).get("videoId");
	return id && /^[A-Za-z0-9_-]{1,255}$/.test(id) ? id : null;
}

async function request(method: "GET" | "POST" | "PATCH", enabled?: boolean) {
	const id = videoId();
	if (!id) throw new Error("This recording cannot replace its cursor");
	const response = await fetch(
		`/api/editor/videos/${encodeURIComponent(id)}/cursor-reconstruction`,
		{
			method,
			credentials: "same-origin",
			cache: "no-store",
			...(enabled === undefined
				? {}
				: {
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ enabled }),
					}),
		},
	);
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
 * Whether the editor already reloaded toward the same sources moments ago:
 * reaching them again means the reload did not take, so it must not repeat.
 */
function reloadedRecently(id: string, cursorData: boolean) {
	try {
		const key = `cap-cursor-replacement-reload:${id}`;
		const last = JSON.parse(sessionStorage.getItem(key) ?? "null") as {
			at: number;
			cursorData: boolean;
		} | null;
		if (
			last?.cursorData === cursorData &&
			Date.now() - last.at < RELOAD_GUARD_MS
		) {
			return true;
		}
		sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), cursorData }));
	} catch {}
	return false;
}

/**
 * Experimental: browser recordings have their cursor burned in. Processing
 * removes it and reconstructs its path, which the editor then draws as a
 * Studio cursor. The editor reloads whenever the sources the server would
 * now hand it differ from the ones it opened with, so this lives for the
 * whole sidebar rather than the Cursor tab.
 */
export function createWebCursorReplacement() {
	const {
		meta,
		flushProjectConfig,
		editorState,
		setEditorState,
		requestHandoffPlayback,
	} = useEditorContext();
	const [view, setView] = createSignal<CursorReplacementView | null>(null);
	const [busy, setBusy] = createSignal(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;

	const loadedCursorData = () =>
		meta().hasRecordedCursorData ||
		(window as Window & { capWebEditorPointerInput?: boolean })
			.capWebEditorPointerInput === true;

	const schedule = () => {
		if (!disposed && view()?.status === "processing" && !timer) {
			timer = setTimeout(poll, POLL_MS);
		}
	};

	const poll = async () => {
		timer = undefined;
		try {
			const next = await request("GET");
			if (disposed) return;
			setView(next);
		} catch {
			if (disposed) return;
		}
		schedule();
	};

	onMount(() => void poll());
	onCleanup(() => {
		disposed = true;
		if (timer) clearTimeout(timer);
	});

	const reloadOntoSources = async (cursorData: boolean) => {
		const id = videoId();
		if (!id || reloadedRecently(id, cursorData)) {
			toast("Reload the editor to apply the cursor change");
			return;
		}
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
		if (!paused) return;
		await flushProjectConfig();
		window.location.reload();
	};

	createEffect(() => {
		const current = view();
		if (!current || current.status === "processing") return;
		if (current.cursorData !== loadedCursorData()) {
			if (current.cursorData) toast.success("Smooth cursor is ready");
			void reloadOntoSources(current.cursorData);
		}
	});

	const toggle = async (enabled: boolean) => {
		const current = view();
		if (!current || busy()) return;
		setBusy(true);
		try {
			if (enabled && current.status !== "ready") {
				setView(await request("POST"));
				schedule();
			} else {
				setView(await request("PATCH", enabled));
			}
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	return { view, busy, toggle, loadedCursorData };
}

export function WebCursorReplacement(props: {
	controller: ReturnType<typeof createWebCursorReplacement>;
}) {
	return (
		<Show when={props.controller.view()}>
			{(current) => (
				<div class="flex flex-col gap-1.5">
					<Field inline name="Replace cursor" badge="Experimental">
						<Toggle
							checked={
								current().status === "processing" ||
								(current().status === "ready" && current().enabled)
							}
							disabled={
								props.controller.busy() ||
								current().status === "processing" ||
								(!current().eligible && current().status !== "ready")
							}
							onChange={(value) => void props.controller.toggle(value)}
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
