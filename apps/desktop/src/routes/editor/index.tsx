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
