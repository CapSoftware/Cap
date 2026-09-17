import { Effect, getCurrentWindow } from "@tauri-apps/api/window";
import { type as ostype } from "@tauri-apps/plugin-os";
import { cx } from "cva";
import {
	createEffect,
	createResource,
	createSignal,
	lazy,
	onCleanup,
	onMount,
	Show,
	Suspense,
} from "solid-js";
import { generalSettingsStore } from "~/store";
import { commands, type ImageDrawingCommit } from "~/utils/tauri";
import { Editor } from "./Editor";
import { EditorSkeleton } from "./editor-skeleton";
import { PreparingEditorProvider } from "./preparing-editor-context";

const ScreenshotWorkspace = lazy(() => import("./screenshot-workspace"));

export default function () {
	const generalSettings = generalSettingsStore.createQuery();
	const [drawingIndex, setDrawingIndex] = createSignal<number | null>(null);
	const [drawingCommit, setDrawingCommit] = createSignal<ImageDrawingCommit>();
	onMount(() => {
		const openDrawing = (event: Event) => {
			const index = (event as CustomEvent<{ index: number }>).detail?.index;
			if (Number.isInteger(index) && index >= 0) setDrawingIndex(index);
		};
		window.addEventListener("cap-edit-image", openDrawing);
		onCleanup(() => window.removeEventListener("cap-edit-image", openDrawing));
	});
	const [projectKind] = createResource(async () => {
		try {
			const path = await commands.getEditorProjectPath();
			const meta = await commands.getRecordingMetaByPath(path);
			return "segment" in meta && meta.segment.display.fps === 0
				? "screenshot"
				: "media";
		} catch {
			return "media";
		}
	});

	// The window is normally revealed by Rust as soon as it's built and
	// positioned (the native background color is themed, so there's no flash).
	// This reveal path only matters when window transparency is enabled — Rust
	// keeps the window hidden so we can apply the HudWindow effects before it
	// becomes visible. Note: requestAnimationFrame must NOT be used to schedule
	// the reveal — hidden webviews throttle/suspend rAF, which silently pushed
	// every editor open onto the slow fallback timeout.
	let revealed = false;
	const reveal = () => {
		if (revealed) return;
		revealed = true;
		const w = getCurrentWindow();
		void w.show().catch(() => {});
		void w.setFocus().catch(() => {});
	};

	createEffect(() => {
		const transparent = generalSettings.data?.windowTransparency ?? false;
		const applied = Promise.allSettled([
			commands.setWindowTransparent(transparent),
			getCurrentWindow().setEffects({
				effects: transparent ? [Effect.HudWindow] : [],
			}),
		]);
		if (generalSettings.data) void applied.then(reveal);
	});

	// Hard fallback: never leave the window hidden if settings fail to load.
	onMount(() => {
		setTimeout(reveal, 250);
	});

	return (
		<div
			class={cx(
				"relative flex flex-col w-screen h-screen bg-ed-window text-ed-text-1",
				!(
					ostype() === "windows" || !generalSettings.data?.windowTransparency
				) && "bg-transparent-window",
			)}
		>
			<Suspense fallback={<EditorSkeleton />}>
				<Show when={projectKind()} fallback={<EditorSkeleton />}>
					<Show
						when={projectKind() === "screenshot"}
						fallback={
							<>
								<PreparingEditorProvider>
									<Editor drawingCommit={drawingCommit} />
								</PreparingEditorProvider>
								<Show when={drawingIndex() !== null}>
									<div class="absolute inset-0 z-[9999] bg-ed-window">
										<ScreenshotWorkspace
											imageDrawingIndex={drawingIndex() ?? 0}
											onExit={() => setDrawingIndex(null)}
											onCommit={setDrawingCommit}
										/>
									</div>
								</Show>
							</>
						}
					>
						<ScreenshotWorkspace />
					</Show>
				</Show>
			</Suspense>
		</div>
	);
}
