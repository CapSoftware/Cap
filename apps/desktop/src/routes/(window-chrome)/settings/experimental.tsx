import { invoke } from "@tauri-apps/api/core";
import { type } from "@tauri-apps/plugin-os";
import { createResource, Show } from "solid-js";
import { createStore } from "solid-js/store";

import { generalSettingsStore } from "~/store";
import {
	deriveGeneralSettings,
	type GeneralSettingsStore,
} from "~/utils/general-settings";
import {
	Section,
	SectionRows,
	SettingsPageContent,
	ToggleSettingItem,
} from "./Setting";

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

		const previousValue = settings[key];
		setSettings(key as keyof GeneralSettingsStore, value);
		try {
			if (key === "enableNativeCameraPreview") {
				await invoke("set_native_camera_preview_enabled", { enabled: value });
				await generalSettingsStore.set({ [key]: value });
			} else {
				await generalSettingsStore.set({ [key]: value });
			}
		} catch (error) {
			setSettings(key as keyof GeneralSettingsStore, previousValue);
			console.error(`Failed to update ${key}`, error);
		}
	};

	return (
		<div class="cap-settings-page flex flex-col h-full custom-scroll">
			<SettingsPageContent>
				<Show
					when={props.osType !== "windows"}
					fallback={
						<p class="text-xs leading-relaxed text-gray-10 px-1">
							No experimental features are currently available on this platform.
						</p>
					}
				>
					<Section title="Preview">
						<SectionRows>
							<ToggleSettingItem
								label="Native camera preview"
								description="Render the camera preview using a native GPU surface instead of through the webview. Experimental and off by default."
								value={!!settings.enableNativeCameraPreview}
								onChange={(value) =>
									handleChange("enableNativeCameraPreview", value)
								}
							/>
						</SectionRows>
					</Section>
				</Show>

				<Section title="Reliability">
					<SectionRows>
						<ToggleSettingItem
							label="Out-of-process muxer"
							description="Run the fragmented-MP4 muxer in an isolated subprocess so muxer crashes can't take down your recording. Requires the bundled cap-muxer binary."
							value={!!settings.outOfProcessMuxer}
							onChange={(value) => handleChange("outOfProcessMuxer", value)}
						/>
					</SectionRows>
				</Section>
			</SettingsPageContent>
		</div>
	);
}
