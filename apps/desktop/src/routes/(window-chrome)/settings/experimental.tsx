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
				await commands.destroyCameraWindow();
			} catch (error) {
				console.error("Failed to destroy camera window", error);
			}
		}
	};

	return (
		<div class="flex flex-col h-full custom-scroll">
			<div class="px-6 py-6 space-y-7 max-w-[42rem]">
				<div class="flex flex-col gap-1 px-1">
					<h2 class="text-base font-semibold tracking-tight text-gray-12">
						Experimental
					</h2>
					<p class="text-xs leading-relaxed text-gray-10">
						In-development features that may not work as expected.
					</p>
				</div>

				<Show
					when={props.osType !== "windows"}
					fallback={
						<p class="text-xs text-gray-10 px-1">
							No experimental features are currently available on this platform.
						</p>
					}
				>
					<section class="space-y-2.5">
						<header class="px-1">
							<h3 class="text-sm font-semibold tracking-tight text-gray-12">
								Preview
							</h3>
						</header>
						<div class="overflow-hidden rounded-xl border border-gray-3 bg-gray-2">
							<ToggleSettingItem
								label="Native camera preview"
								description="Render the camera preview using a native GPU surface instead of through the webview. Not stable on certain Windows systems."
								value={!!settings.enableNativeCameraPreview}
								onChange={(value) =>
									handleChange("enableNativeCameraPreview", value)
								}
							/>
						</div>
					</section>
				</Show>

				<section class="space-y-2.5">
					<header class="px-1">
						<h3 class="text-sm font-semibold tracking-tight text-gray-12">
							Reliability
						</h3>
					</header>
					<div class="overflow-hidden rounded-xl border border-gray-3 bg-gray-2">
						<ToggleSettingItem
							label="Out-of-process muxer"
							description="Run the fragmented-MP4 muxer in an isolated subprocess so muxer crashes can't take down your recording. Requires the bundled cap-muxer binary."
							value={!!settings.outOfProcessMuxer}
							onChange={(value) => handleChange("outOfProcessMuxer", value)}
						/>
					</div>
				</section>
			</div>
		</div>
	);
}
