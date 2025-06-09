import { Button } from "@cap/ui-solid";
import { createWritableMemo } from "@solid-primitives/memo";
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";
import { type, type OsType } from "@tauri-apps/plugin-os";
import "@total-typescript/ts-reset/filter-boolean";
import { createResource, For, ParentProps, Show } from "solid-js";
import { createStore } from "solid-js/store";

import { authStore, generalSettingsStore } from "~/store";
import {
  commands,
  type AppTheme,
  type GeneralSettingsStore,
  type MainWindowRecordingStartBehaviour,
  type PostStudioRecordingBehaviour,
} from "~/utils/tauri";
// import { themeStore } from "~/store/theme";
import { CheckMenuItem, Menu } from "@tauri-apps/api/menu";
import { confirm } from "@tauri-apps/plugin-dialog";
import { cx } from "cva";
import themePreviewAuto from "~/assets/theme-previews/auto.jpg";
import themePreviewDark from "~/assets/theme-previews/dark.jpg";
import themePreviewLight from "~/assets/theme-previews/light.jpg";
import { Toggle } from "~/components/Toggle";
import { TextInput } from "~/routes/editor/TextInput";
import { Setting, ToggleSetting } from "./Setting";

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
                  class={cx(
                    `w-24 h-[4.8rem] rounded-md overflow-hidden focus:outline-none ring-offset-gray-50 transition-all duration-200`,
                    {
                      "ring-2 ring-offset-2": props.currentTheme === theme.id,
                      "group-hover:ring-2 ring-offset-2 group-hover:ring-gray-5":
                        props.currentTheme !== theme.id,
                    }
                  )}
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
                  class={cx(`mt-2 text-sm transition-color duration-200`, {
                    "text-blue-9": props.currentTheme === theme.id,
                    "text-gray-11": props.currentTheme !== theme.id,
                  })}
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

  const handleChange = async <K extends keyof typeof settings>(
    key: K,
    value: (typeof settings)[K]
  ) => {
    console.log(`Handling settings change for ${key}: ${value}`);

    setSettings(key as keyof GeneralSettingsStore, value);
    generalSettingsStore.set({ [key]: value });
  };

  const ostype: OsType = type();

  return (
    <div class="flex flex-col w-full h-full">
      <div class="flex-1 custom-scroll">
        <div class="p-4 space-y-2 divide-y divide-gray-200">
          <AppearanceSection
            currentTheme={settings.theme ?? "system"}
            onThemeChange={(newTheme) => {
              setSettings("theme", newTheme);
              generalSettingsStore.set({ theme: newTheme });
            }}
          />
          <ToggleSetting
            pro
            label="Disable automatic link opening"
            description="When enabled, Cap will not automatically open links in your browser (e.g. after creating a shareable link)."
            value={!!settings.disableAutoOpenLinks}
            onChange={(value) => handleChange("disableAutoOpenLinks", value)}
          />

          {ostype === "macos" && (
            <>
              <ToggleSetting
                label="Hide dock icon"
                description="The dock icon will be hidden when there are no windows available to close."
                value={!!settings.hideDockIcon}
                onChange={(value) => handleChange("hideDockIcon", value)}
              />
              <ToggleSetting
                label="Enable haptics"
                description="Use haptics on Force Touch™ trackpads"
                value={!!settings.hapticsEnabled}
                onChange={(value) => handleChange("hapticsEnabled", value)}
              />
            </>
          )}
          <ToggleSetting
            label="Enable system notifications"
            description="Show system notifications for events like copying to clipboard, saving files, and more. You may need to manually allow Cap access via your system's notification settings."
            value={!!settings.enableNotifications}
            onChange={async (value) => {
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

              handleChange("enableNotifications", value);
            }}
          />
          {/* <ToggleSetting
            label="Enable window transparency"
            description="Make the background of some windows (eg. the Editor) transparent."
            value={!!settings.windowTransparency}
            onChange={(value) => handleChange("windowTransparency", value)}
          /> */}
          <Setting
            label="Studio recording finish behaviour"
            description="What should happen when a studio recording finishes"
          >
            <button
              class="flex flex-row gap-1 items-center px-2 py-1 rounded-md border border-gray-300"
              onClick={async () => {
                const item = (
                  text: string,
                  value: PostStudioRecordingBehaviour
                ) =>
                  CheckMenuItem.new({
                    text,
                    checked: settings.postStudioRecordingBehaviour === value,
                    action: () =>
                      handleChange("postStudioRecordingBehaviour", value),
                  });
                const menu = await Menu.new({
                  items: await Promise.all([
                    item("Open editor", "openEditor"),
                    item("Show in overlay", "showOverlay"),
                  ]),
                });
                menu.popup();
              }}
            >
              {settings.postStudioRecordingBehaviour === "showOverlay"
                ? "Show in overlay"
                : "Open editor"}
              <IconCapChevronDown class="size-4" />
            </button>
          </Setting>
          <Setting
            label="Main window recording start behaviour"
            description="What should the main window do when starting a recording"
          >
            <button
              class="flex flex-row gap-1 items-center px-2 py-1 rounded-md border border-gray-300"
              onClick={async () => {
                const item = (
                  text: string,
                  value: MainWindowRecordingStartBehaviour
                ) =>
                  CheckMenuItem.new({
                    text,
                    checked:
                      settings.mainWindowRecordingStartBehaviour === value,
                    action: () =>
                      handleChange("mainWindowRecordingStartBehaviour", value),
                  });
                const menu = await Menu.new({
                  items: await Promise.all([
                    item("Close", "close"),
                    item("Minimise", "minimise"),
                  ]),
                });
                menu.popup();
              }}
            >
              {settings.mainWindowRecordingStartBehaviour === "close"
                ? "Close"
                : "Minimise"}
              <IconCapChevronDown class="size-4" />
            </button>
          </Setting>
          <ServerURLSetting
            value={settings.serverUrl ?? "https://cap.so"}
            onChange={async (v) => {
              const url = new URL(v);
              const origin = url.origin;

              if (
                !(await confirm(
                  `Are you sure you want to change the server URL to '${origin}'? You will need to sign in again.`
                ))
              )
                return;

              await authStore.set(undefined);
              await commands.setServerUrl(origin);
              handleChange("serverUrl", origin);
            }}
          />
        </div>
      </div>
    </div>
  );
}

function ServerURLSetting(props: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [value, setValue] = createWritableMemo(() => props.value);

  return (
    <Setting
      label="Cap Server URL"
      description="This setting should only be changed if you are self hosting your own instance of Cap Web."
    >
      <div class="flex flex-col gap-2 items-end">
        <TextInput
          class="flex flex-row gap-1 items-center px-2 py-1 rounded-md border outline-none border-gray-7 bg-gray-1 focus:border-blue-10 max-w-48"
          value={value()}
          onInput={(e) => setValue(e.currentTarget.value)}
        />
        <Button
          size="sm"
          disabled={props.value === value()}
          onClick={() => props.onChange(value())}
        >
          Update
        </Button>
      </div>
    </Setting>
  );
}
