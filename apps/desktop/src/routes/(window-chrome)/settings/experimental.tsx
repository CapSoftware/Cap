import { Slider as KSlider } from "@kobalte/core/slider";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { type } from "@tauri-apps/plugin-os";
import { createResource, Show } from "solid-js";
import { createStore } from "solid-js/store";

import { generalSettingsStore } from "~/store";
import {
	type AutoZoomConfig,
	commands,
	type GeneralSettingsStore,
} from "~/utils/tauri";
import { ToggleSettingItem } from "./Setting";

function SettingSlider(props: {
	label: string;
	value: number;
	onChange: (v: number) => void;
	min: number;
	max: number;
	step: number;
	format?: (v: number) => string;
}) {
	return (
		<div class="space-y-1.5">
			<div class="flex justify-between items-center text-sm">
				<span class="text-gray-11">{props.label}</span>
				<span class="text-gray-12 font-medium">
					{props.format ? props.format(props.value) : props.value}
				</span>
			</div>
			<KSlider
				value={[props.value]}
				onChange={(v) => props.onChange(v[0])}
				minValue={props.min}
				maxValue={props.max}
				step={props.step}
			>
				<KSlider.Track class="h-[0.3rem] cursor-pointer relative bg-gray-4 rounded-full w-full">
					<KSlider.Fill class="absolute h-full rounded-full bg-blue-9" />
					<KSlider.Thumb class="block size-4 rounded-full bg-white border-2 border-blue-9 -top-[0.35rem] outline-none" />
				</KSlider.Track>
			</KSlider>
		</div>
	);
}

export default function ExperimentalSettings() {
	const [store] = createResource(() => generalSettingsStore.get());

	return (
		<Show when={store.state === "ready" && ([store()] as const)}>
			{(store) => <Inner initialStore={store()[0] ?? null} />}
		</Show>
	);
}

function Inner(props: { initialStore: GeneralSettingsStore | null }) {
	const [settings, setSettings] = createStore<GeneralSettingsStore>(
		props.initialStore ?? {
			uploadIndividualFiles: false,
			hideDockIcon: false,
			autoCreateShareableLink: false,
			enableNotifications: true,
			enableNativeCameraPreview: false,
			autoZoomOnClicks: false,
			custom_cursor_capture2: true,
			autoZoomConfig: {
				zoomAmount: 1.5,
				clickGroupTimeThreshold: 2.5,
				clickGroupSpatialThreshold: 0.15,
				clickPrePadding: 0.4,
				clickPostPadding: 1.8,
				movementPrePadding: 0.3,
				movementPostPadding: 1.5,
				mergeGapThreshold: 0.8,
				minSegmentDuration: 1.0,
				movementEventDistanceThreshold: 0.02,
				movementWindowDistanceThreshold: 0.08,
			},
		},
	);

	const handleConfigChange = <K extends keyof AutoZoomConfig>(
		key: K,
		value: AutoZoomConfig[K],
	) => {
		setSettings("autoZoomConfig", key, value);
		generalSettingsStore.set({
			autoZoomConfig: { ...settings.autoZoomConfig, [key]: value },
		});
	};

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
				<div class="space-y-3">
					<h3 class="text-sm text-gray-12 w-fit">Recording Features</h3>
					<div class="px-3 rounded-xl border divide-y divide-gray-3 border-gray-3 bg-gray-2">
						<ToggleSettingItem
							label="Custom cursor capture in Studio Mode"
							description="Studio Mode recordings will capture cursor state separately for customisation (size, smoothing) in the editor. Currently experimental as cursor events may not be captured accurately."
							value={!!settings.custom_cursor_capture2}
							onChange={(value) =>
								handleChange("custom_cursor_capture2", value)
							}
						/>
						{type() !== "windows" && (
							<ToggleSettingItem
								label="Native camera preview"
								description="Show the camera preview using a native GPU surface instead of rendering it within the webview. This is not functional on certain Windows systems so your mileage may vary."
								value={!!settings.enableNativeCameraPreview}
								onChange={(value) =>
									handleChange("enableNativeCameraPreview", value)
								}
							/>
						)}
						<ToggleSettingItem
							label="Auto zoom on clicks"
							description="Automatically generate zoom segments around mouse clicks during Studio Mode recordings. This helps highlight important interactions in your recordings."
							value={!!settings.autoZoomOnClicks}
							onChange={(value) => {
								handleChange("autoZoomOnClicks", value);
								setTimeout(
									() => window.scrollTo({ top: 0, behavior: "instant" }),
									5,
								);
							}}
						/>
					</div>
					<Show when={settings.autoZoomOnClicks}>
						<div class="px-3 py-3 space-y-4">
							<SettingSlider
								label="Zoom Amount"
								value={settings.autoZoomConfig?.zoomAmount ?? 1.5}
								onChange={(v) => handleConfigChange("zoomAmount", v)}
								min={1.0}
								max={4.0}
								step={0.1}
								format={(v) => `${v.toFixed(1)}x`}
							/>
							<SettingSlider
								label="Sensitivity"
								value={
									settings.autoZoomConfig?.movementWindowDistanceThreshold ??
									0.08
								}
								onChange={(v) =>
									handleConfigChange("movementWindowDistanceThreshold", v)
								}
								min={0.02}
								max={0.2}
								step={0.01}
								format={(v) => {
									if (v <= 0.05) return "High";
									if (v <= 0.12) return "Medium";
									return "Low";
								}}
							/>
							<SettingSlider
								label="Smoothing"
								value={settings.autoZoomConfig?.mergeGapThreshold ?? 0.8}
								onChange={(v) => handleConfigChange("mergeGapThreshold", v)}
								min={0.2}
								max={2.0}
								step={0.1}
								format={(v) => `${v.toFixed(1)}s`}
							/>
						</div>
					</Show>
				</div>
			</div>
		</div>
	);
}
