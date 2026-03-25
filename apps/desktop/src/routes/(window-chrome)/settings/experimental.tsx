import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { type } from "@tauri-apps/plugin-os";
import { createResource, Show } from "solid-js";
import { createStore } from "solid-js/store";

import { generalSettingsStore } from "~/store";
import {
	deriveGeneralSettings,
	type GeneralSettingsStore,
} from "~/utils/general-settings";
import { commands } from "~/utils/tauri";
import { ToggleSettingItem } from "./Setting";

export default function ExperimentalSettings() {
	const [store] = createResource(() => generalSettingsStore.get());
	const osType = type();

	return (
		<Show when={store.state === "ready" && ([store()] as const)}>
			{(store) => <Inner initialStore={store()[0] ?? null} osType={osType} />}
		</Show>
	);
}

function Inner(props: {
	initialStore: GeneralSettingsStore | null;
	osType: ReturnType<typeof type>;
}) {
	const [settings, setSettings] = createStore<GeneralSettingsStore>(
		deriveGeneralSettings(props.initialStore),
	);

	const handleChange = async <K extends keyof typeof settings>(
		key: K,
		value: (typeof settings)[K],
	) => {
		console.log(`Handling settings change for ${key}: ${value}`);

		setSettings(key as keyof GeneralSettingsStore, value);
		generalSettingsStore.set({ [key]: value });
		if (key === "enableNativeCameraPreview") {
			await commands.setCameraInput(null, true);
			try {
				const cameraWindow = await WebviewWindow.getByLabel("camera");
				await cameraWindow?.close();
			} catch (error) {
				console.error("Failed to close camera window", error);
			}
		}
	};

	return (
		<div class="flex flex-col h-full custom-scroll">
			<div class="p-4 space-y-4">
				<div class="flex flex-col pb-4 border-b border-gray-2">
					<h2 class="text-lg font-medium text-gray-12">
						Experimental Features
					</h2>
					<p class="text-sm text-gray-10">
						These features are still in development and may not work as
						expected.
					</p>
				</div>
				<Show
					when={props.osType !== "windows"}
					fallback={
						<p class="text-sm text-gray-10">
							No experimental features are currently available on this platform.
						</p>
					}
				>
					<div class="space-y-3">
						<h3 class="text-sm text-gray-12 w-fit">Preview</h3>
						<div class="px-3 rounded-xl border divide-y divide-gray-3 border-gray-3 bg-gray-2">
							<ToggleSettingItem
								label="Native camera preview"
								description="Show the camera preview using a native GPU surface instead of rendering it within the webview. This is not functional on certain Windows systems so your mileage may vary."
								value={!!settings.enableNativeCameraPreview}
								onChange={(value) =>
									handleChange("enableNativeCameraPreview", value)
								}
							/>
						</div>
					</div>
				</Show>
			</div>
		</div>
	);
}
