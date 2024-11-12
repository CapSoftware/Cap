import { createResource, Show, For } from "solid-js";
import { createStore } from "solid-js/store";
import { generalSettingsStore } from "~/store";
import { commands, type GeneralSettingsStore } from "~/utils/tauri";
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";

const settingsList = [
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
    key: "disable_auto_open_links",
    label: "Cap Pro: Disable automatic link opening",
    description:
      "When enabled, Cap will not automatically open links in your browser (e.g. after creating a shareable link).",
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

  const handleChange = async (key: string, value: boolean) => {
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

    setSettings(key as keyof GeneralSettingsStore, value);
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
                  <button
                    type="button"
                    role="switch"
                    aria-checked={
                      settings[setting.key as keyof GeneralSettingsStore]
                    }
                    data-state={
                      settings[setting.key as keyof GeneralSettingsStore]
                        ? "checked"
                        : "unchecked"
                    }
                    value={
                      settings[setting.key as keyof GeneralSettingsStore]
                        ? "on"
                        : "off"
                    }
                    class={`peer inline-flex h-4 w-8 shrink-0 cursor-pointer items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 ${
                      settings[setting.key as keyof GeneralSettingsStore]
                        ? "bg-blue-400 border-blue-400"
                        : "bg-gray-300 border-gray-300"
                    }`}
                    onClick={() =>
                      handleChange(
                        setting.key,
                        !settings[setting.key as keyof GeneralSettingsStore]
                      )
                    }
                  >
                    <span
                      data-state={
                        settings[setting.key as keyof GeneralSettingsStore]
                          ? "checked"
                          : "unchecked"
                      }
                      class={`pointer-events-none block h-4 w-4 rounded-full bg-gray-50 shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0 border-2 ${
                        settings[setting.key as keyof GeneralSettingsStore]
                          ? "border-blue-400"
                          : "border-gray-300"
                      }`}
                    />
                  </button>
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
