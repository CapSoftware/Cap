import { Effect, getCurrentWindow } from "@tauri-apps/api/window";
import { type as ostype } from "@tauri-apps/plugin-os";
import { cx } from "cva";
import { createEffect, createSignal, onMount, Show } from "solid-js";
import { AbsoluteInsetLoader } from "~/components/Loader";
import { generalSettingsStore } from "~/store";
import { commands } from "~/utils/tauri";
import { ScreenshotEditorProvider } from "./context";
import { Editor } from "./Editor";

export default function ScreenshotEditorRoute() {
	const generalSettings = generalSettingsStore.createQuery();
	const [path, setPath] = createSignal<string | null>(null);

	onMount(() => {
		// @ts-expect-error
		const initialPath = window.__CAP__?.screenshotPath;
		if (initialPath) {
			setPath(initialPath);
		}
	});

	createEffect(() => {
		const transparent = generalSettings.data?.windowTransparency ?? false;
		commands.setWindowTransparent(transparent);
		getCurrentWindow().setEffects({
			effects: transparent ? [Effect.HudWindow] : [],
		});
	});

	return (
		<div
			class={cx(
				"flex flex-col w-screen h-screen dark:bg-gray-1 bg-gray-2",
				!(
					ostype() === "windows" || !generalSettings.data?.windowTransparency
				) && "bg-transparent-window",
			)}
		>
			<Show when={path()} fallback={<AbsoluteInsetLoader />}>
				{(p) => (
					<ScreenshotEditorProvider path={p()}>
						<Editor />
					</ScreenshotEditorProvider>
				)}
			</Show>
		</div>
	);
}
