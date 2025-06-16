import { createResource, Show } from "solid-js";
import { createStore } from "solid-js/store";

import { generalSettingsStore } from "~/store";
import { type GeneralSettingsStore, commands } from "~/utils/tauri";
import { ToggleSetting } from "./Setting";
import { Button } from "@cap/ui-solid";

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
            <h2 class="text-gray-12 text-lg font-medium">
              Experimental Features
            </h2>
            <p class="text-gray-11 text-sm">
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

          <div class="py-4">
            <div class="flex items-center justify-between">
              <div class="flex-1">
                <h3 class="text-gray-12 text-sm font-medium">Teleprompter</h3>
                <p class="text-gray-11 text-xs mt-1">
                  Open a teleprompter window that stays on top and can be made
                  transparent for use during recordings.
                </p>
              </div>
              <Button
                onClick={() => commands.showWindow("Teleprompter")}
                class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
              >
                Open Teleprompter
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
