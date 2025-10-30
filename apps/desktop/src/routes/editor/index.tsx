import { Effect, getCurrentWindow } from "@tauri-apps/api/window";
import { type as ostype } from "@tauri-apps/plugin-os";
import { cx } from "cva";
import { createEffect, Suspense } from "solid-js";
import { AbsoluteInsetLoader } from "~/components/Loader";
import { generalSettingsStore } from "~/store";
import { commands } from "~/utils/tauri";
import { Editor } from "./Editor";

export default function () {
	const generalSettings = generalSettingsStore.createQuery();

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
			<Suspense fallback={<AbsoluteInsetLoader />}>
				<Editor />
			</Suspense>
		</div>
	);
}
