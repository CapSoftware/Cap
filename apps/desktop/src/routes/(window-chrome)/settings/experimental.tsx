import { createResource, Show } from "solid-js";
import { createStore } from "solid-js/store";

import { generalSettingsStore } from "~/store";
import { type GeneralSettingsStore } from "~/utils/tauri";
import { ToggleSetting } from "./Setting";

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

  return (
    <div class="flex flex-col w-full h-full">
      <div class="flex-1 custom-scroll">
        <div class="p-4 space-y-2 divide-y divide-gray-200">
          <div class="py-2 mb-4">
            <h2 class="text-[--text-primary] text-lg font-medium">
              Experimental Features
            </h2>
            <p class="text-[--text-secondary] text-sm">
              These features are still in development and may not work as
              expected.
            </p>
          </div>

          <ToggleSetting
            label="Custom cursor capture in Studio Mode"
            description="Studio Mode recordings will capture cursor state separately for customisation (size, smoothing) in the editor. Currently experimental as cursor events may not be captured accurately."
            value={!!settings.customCursorCapture}
            onChange={(value) => handleChange("customCursorCapture", value)}
          />

          <ToggleSetting
            label="System audio capture"
            description="Provides the option for you to capture audio coming from your system, such as music or video playback."
            value={!!settings.systemAudioCapture}
            onChange={(value) => handleChange("systemAudioCapture", value)}
          />
        </div>
      </div>
    </div>
  );
}
