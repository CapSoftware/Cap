import { createResource, For, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { generalSettingsStore } from "~/store";
import type { AppTheme, GeneralSettingsStore } from "~/utils/tauri";
// import { themeStore } from "~/store/theme";
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";
import { type OsType, type } from "@tauri-apps/plugin-os";
import themePreviewAuto from "~/assets/theme-previews/auto.jpg";
import themePreviewDark from "~/assets/theme-previews/dark.jpg";
import themePreviewLight from "~/assets/theme-previews/light.jpg";
import { Switch } from "~/components";

const settingsList: Array<{
  key: keyof GeneralSettingsStore;
  label: string;
  description: string;
  platforms?: OsType[];
  requiresPermission?: boolean;
  pro?: boolean;
  onChange?: (value: boolean) => Promise<void>;
}> = [
  // {
  //   key: "autoCreateShareableLink",
  //   label: "Automatically generate shareable link after recording",
  //   description:
  //     "When enabled, a shareable link will be created automatically after stopping the recording. You'll be redirected to the URL while the upload continues in the background.",
  //   pro: true,
  // },
  // {
  //   key: "uploadIndividualFiles",
  //   label: "Upload individual recording files when creating shareable link",
  //   description:
  //     'Warning: this will cause shareable link uploads to become significantly slower, since all individual recording files will be uploaded. Shows "Download Assets" button in Share page.',
  // },
  {
    key: "openEditorAfterRecording",
    label: "Open editor automatically after recording stops",
    description:
      "The editor will be shown immediately after you finish recording.",
  },
  {
    key: "hideDockIcon",
    label: "Hide dock icon",
    platforms: ["macos"],
    description:
      "The dock icon will be hidden when there are no windows available to close.",
  },
  {
    key: "hapticsEnabled",
    label: "Enable Haptics",
    platforms: ["macos"],
    description: "Use haptics on Force Touch™ trackpads",
  },
  {
    key: "disableAutoOpenLinks",
    label: "Disable automatic link opening",
    description:
      "When enabled, Cap will not automatically open links in your browser (e.g. after creating a shareable link).",
    pro: true,
  },
  {
    key: "enableNotifications",
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

function AppearanceSection(props: {
  currentTheme: AppTheme;
  onThemeChange: (theme: AppTheme) => void;
}) {
  const options = [
    { id: "system", name: "System", preview: themePreviewAuto },
    { id: "light", name: "Light", preview: themePreviewLight },
    { id: "dark", name: "Dark", preview: themePreviewDark },
  ] satisfies { id: AppTheme; name: string; preview: string }[];

  return (
    <div class="flex flex-col gap-4">
      <p class="text-[--text-primary]">Appearance</p>
      <div
        class="flex justify-start items-center text-[--text-primary]"
        onContextMenu={(e) => e.preventDefault()}
      >
        <div class="flex justify-between m-1 min-w-[20rem] w-[22.2rem] flex-nowrap">
          <For each={options}>
            {(theme) => (
              <button
                type="button"
                aria-checked={props.currentTheme === theme.id}
                class="flex flex-col items-center rounded-md group focus:outline-none focus-visible:ring-gray-300 focus-visible:ring-offset-gray-50 focus-visible:ring-offset-2 focus-visible:ring-4"
                onClick={() => props.onThemeChange(theme.id)}
              >
                <div
                  class={`w-24 h-[4.8rem] rounded-md overflow-hidden focus:outline-none ring-offset-gray-50 transition-all duration-200 ${
                    props.currentTheme === theme.id
                      ? "ring-2 ring-offset-2"
                      : "group-hover:ring-2 ring-offset-2 group-hover:ring-gray-300"
                  }`}
                  aria-label={`Select theme: ${theme.name}`}
                >
                  <div class="flex justify-center items-center w-full h-full">
                    <img
                      draggable={false}
                      src={theme.preview}
                      alt={`Preview of ${theme.name} theme`}
                    />
                  </div>
                </div>
                <span
                  class={`mt-2 text-sm transition-color duration-200 ${
                    props.currentTheme === theme.id ? "text-blue-400" : ""
                  }`}
                >
                  {theme.name}
                </span>
              </button>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}

function Inner(props: { initialStore: GeneralSettingsStore | null }) {
  const [settings, setSettings] = createStore<GeneralSettingsStore>(
    props.initialStore ?? {
      uploadIndividualFiles: false,
      openEditorAfterRecording: false,
      hideDockIcon: false,
      autoCreateShareableLink: false,
      enableNotifications: true,
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

    // Find the setting once and store it
    const setting = settingsList.find((s) => s.key === key);

    // If setting exists and has onChange handler, call it
    if (setting?.onChange) {
      await setting.onChange(value);
    }

    setSettings(key as keyof GeneralSettingsStore, value);
    generalSettingsStore.set({ [key]: value });
  };

  const ostype: OsType = type();

  return (
    <div class="flex flex-col w-full h-full">
      <div class="overflow-y-auto flex-1">
        <div class="p-4 space-y-2 divide-y divide-gray-200">
          <AppearanceSection
            currentTheme={settings.theme ?? "system"}
            onThemeChange={(newTheme) => {
              setSettings("theme", newTheme);
              generalSettingsStore.set({ theme: newTheme });
            }}
          />
          <For each={settingsList}>
            {(setting) => {
              const value = () => !!settings[setting.key];

              return (
                <Show
                  when={
                    !setting.platforms || setting.platforms.includes(ostype)
                  }
                >
                  <div class="py-3 space-y-2">
                    {setting.pro && (
                      <span class="px-2 py-1 text-xs font-medium text-gray-50 bg-blue-400 rounded-lg">
                        Cap Pro
                      </span>
                    )}
                    <div class="flex justify-between items-center">
                      <div class="flex gap-2 items-center">
                        <p class="text-[--text-primary]">{setting.label}</p>
                      </div>
                      <Switch
                        checked={value()}
                        onChange={(e) => handleChange(setting.key, e)}
                      />
                    </div>
                    {setting.description && (
                      <p class="text-xs text-[--text-tertiary]">
                        {setting.description}
                      </p>
                    )}
                  </div>
                </Show>
              );
            }}
          </For>
        </div>
      </div>
    </div>
  );
}
