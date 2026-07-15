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
							当前平台暂无可用的实验性功能。
						</p>
					}
				>
					<Section title="预览">
						<SectionRows>
							<ToggleSettingItem
								label="原生摄像头预览"
								description="使用原生 GPU 表面渲染摄像头预览，而非通过 WebView。此功能为实验性功能，默认关闭。"
								value={!!settings.enableNativeCameraPreview}
								onChange={(value) =>
									handleChange("enableNativeCameraPreview", value)
								}
							/>
						</SectionRows>
					</Section>
				</Show>

				<Section title="可靠性">
					<SectionRows>
						<ToggleSettingItem
							label="进程外封装器"
							description="在独立子进程中运行分片 MP4 封装器，避免封装器崩溃导致录制中断。需要内置的 cap-muxer 二进制文件。"
							value={!!settings.outOfProcessMuxer}
							onChange={(value) => handleChange("outOfProcessMuxer", value)}
						/>
					</SectionRows>
				</Section>
			</SettingsPageContent>
		</div>
	);
}
