import { createResource, Show, For } from "solid-js";
import { createStore } from "solid-js/store";
import { generalSettingsStore } from "~/store";
import { commands, type GeneralSettingsStore } from "~/utils/tauri";

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
];

export default function GeneralSettings() {
  const [store] = createResource(() => generalSettingsStore.get());

  return (
    <Show
      when={(() => {
        const s = store();
        if (s === undefined) return;
        return [s];
      })()}
    >
      {(store) => <Inner store={store()[0]} />}
    </Show>
  );
}

function Inner(props: { store: GeneralSettingsStore | null }) {
  const [settings, setSettings] = createStore<GeneralSettingsStore>(
    props.store ?? {
      upload_individual_files: false,
      open_editor_after_recording: false,
    }
  );

  const handleChange = async (key: string, value: boolean) => {
    setSettings(key as keyof GeneralSettingsStore, value);
    await commands.setGeneralSettings({
      ...settings,
      [key]: value,
    });
  };

  return (
    <div class="flex flex-col w-full h-full divide-y divide-gray-200 pb-12">
      <div class="flex-1 p-4 space-y-2 divide-y divide-gray-200">
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
  );
}
