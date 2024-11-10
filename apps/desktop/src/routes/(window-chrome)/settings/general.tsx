import { createResource, Show, For } from "solid-js";
import { createStore } from "solid-js/store";
import { generalSettingsStore } from "~/store";
import { commands, type GeneralSettingsStore } from "~/utils/tauri";
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";
import { SwitchButton } from "~/components/SwitchButton";

type Setting = {
  key: keyof GeneralSettingsStore,
  label: string,
  description: string,
  requiresPermission?: boolean,
};

const settingsList: Setting[] = [
  {
    key: "upload_individual_files",
    label: "Upload individual recording files when creating shareable link",
    description:
      'Warning: this will cause shareable link uploads to become significantly slower, since all individual recording files will be uploaded. Shows "Download Assets" button in Share page.',
  },
  {
    key: "open_editor_after_recording",
    label: "Open editor automatically after recording stops",
    description:
      "The editor will be shown immediately after you finish recording.",
  },
  {
    key: "hide_dock_icon",
    label: "Hide dock icon",
    description:
      "The dock icon will be hidden when there are no windows available to close.",
  },
  {
    key: "auto_create_shareable_link",
    label: "Cap Pro: Automatically create shareable link after recording",
    description:
      "When enabled, a shareable link will be created automatically after stopping the recording. You'll be redirected to the URL while the upload continues in the background.",
  },
  {
    key: "enable_notifications",
    label: "Enable System Notifications",
    description:
      "Show system notifications for events like copying to clipboard, saving files, and more. You may need to manually allow Cap access via your system's notification settings.",
    requiresPermission: true,
  },
];

export default function GeneralSettings() {
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
      upload_individual_files: false,
      open_editor_after_recording: false,
      hide_dock_icon: false,
      auto_create_shareable_link: false,
      enable_notifications: true,
    }
  );

  const handleChange = async (key: keyof GeneralSettingsStore, value: boolean) => {
    console.log(`Handling settings change for ${key}: ${value}`);
    // Special handling for notifications permission
    if (key === "enable_notifications") {
      if (value) {
        // Check current permission state
        console.log("Checking notification permission status");
        const permissionGranted = await isPermissionGranted();
        console.log(`Current permission status: ${permissionGranted}`);

        if (!permissionGranted) {
          // Request permission if not granted
          console.log("Permission not granted, requesting permission");
          const permission = await requestPermission();
          console.log(`Permission request result: ${permission}`);
          if (permission !== "granted") {
            // If permission denied, don't enable the setting
            console.log("Permission denied, aborting setting change");
            return;
          }
        }
      }
    }

    setSettings(key, value);
    await commands.setGeneralSettings({
      ...settings,
      [key]: value,
    });
  };

  return (
    <div class="flex flex-col w-full h-full">
      <div class="flex-1 overflow-y-auto">
        <div class="p-4 space-y-2 divide-y divide-gray-200">
          <For each={settingsList}>
            {(setting) => (
              <div class="space-y-2 py-3">
                <div class="flex items-center justify-between">
                  <p>{setting.label}</p>
                  <SwitchButton
                    name={setting.key}
                    value={settings[setting.key]!}
                    onChange={handleChange}
                  />
                </div>
                {setting.description && (
                  <p class="text-xs text-gray-400">{setting.description}</p>
                )}
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
