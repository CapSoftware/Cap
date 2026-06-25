import { Effect, getCurrentWindow } from "@tauri-apps/api/window";
import { type as ostype } from "@tauri-apps/plugin-os";
import { cx } from "cva";
import { createEffect, onMount, Suspense } from "solid-js";
import { generalSettingsStore } from "~/store";
import { commands } from "~/utils/tauri";
import { Editor } from "./Editor";
import { EditorSkeleton } from "./editor-skeleton";

export default function () {
	const generalSettings = generalSettingsStore.createQuery();

	// The editor window is built hidden (AUTO_SHOW_WINDOW=false) so we can reveal
	// it only after the theme + transparency are applied and the first frame has
	// painted. Showing earlier (the old behaviour) exposed the placeholder
	// background and then the themed background, producing a visible flash.
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
		commands.setWindowTransparent(transparent);
		getCurrentWindow().setEffects({
			effects: transparent ? [Effect.HudWindow] : [],
		});
		// Once settings have loaded (theme + transparency are now applied), reveal
		// on the next frame so the styled background paints before the window is
		// visible.
		if (generalSettings.data) requestAnimationFrame(reveal);
	});

	// Hard fallback: never leave the window hidden if settings fail to load.
	onMount(() => {
		setTimeout(reveal, 1000);
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
			<Suspense fallback={<EditorSkeleton />}>
				<Editor />
			</Suspense>
		</div>
	);
}
