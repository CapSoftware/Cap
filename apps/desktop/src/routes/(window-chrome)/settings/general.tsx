import { createResource, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { generalSettingsStore } from "~/store";
import { commands, type GeneralSettingsStore } from "~/utils/tauri";

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
    props.store ?? { upload_individual_files: false }
  );

  const handleChange = async (uploadIndividualFiles: boolean) => {
    setSettings("upload_individual_files", uploadIndividualFiles);
    await commands.setGeneralSettings({
      upload_individual_files: uploadIndividualFiles,
    });
  };

  return (
    <div class="flex flex-col w-full h-full divide-y divide-gray-200 pt-1 pb-12">
      <div class="flex-1 p-4 space-y-2">
        <div class="flex items-center justify-between">
          <p>Upload individual recording files when creating shareable link</p>
          <button
            type="button"
            role="switch"
            aria-checked={settings.upload_individual_files}
            data-state={
              settings.upload_individual_files ? "checked" : "unchecked"
            }
            value={settings.upload_individual_files ? "on" : "off"}
            class={`peer inline-flex h-4 w-8 shrink-0 cursor-pointer items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 ${
              settings.upload_individual_files
                ? "bg-blue-400 border-blue-400"
                : "bg-gray-300 border-gray-300"
            }`}
            onClick={() => handleChange(!settings.upload_individual_files)}
          >
            <span
              data-state={
                settings.upload_individual_files ? "checked" : "unchecked"
              }
              class={`pointer-events-none block h-4 w-4 rounded-full bg-gray-50 shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0 border-2 ${
                settings.upload_individual_files
                  ? "border-blue-400"
                  : "border-gray-300"
              }`}
            />
          </button>
        </div>
        <div>
          <p class="text-xs text-gray-400">
            Warning: this will cause shareable link uploads to become
            significantly slower, since multiple files will be uploaded.
          </p>
        </div>
      </div>
    </div>
  );
}
