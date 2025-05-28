import { Button } from "@cap/ui-solid";
import { createSignal, onMount, For } from "solid-js";
import { commands } from "~/utils/tauri";
import { presetsStore } from "~/store";

export default function StreamConfigPage() {
  const [serverUrl, setServerUrl] = createSignal("");
  const [streamKey, setStreamKey] = createSignal("");
  const [presetIndex, setPresetIndex] = createSignal<number | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [loading, setLoading] = createSignal(true);
  const [hasConfig, setHasConfig] = createSignal(false);
  const presets = presetsStore.createQuery();

  const reset = () => {
    setServerUrl("");
    setStreamKey("");
    setPresetIndex(null);
    setHasConfig(false);
  };

  onMount(async () => {
    try {
      const config = await commands.getStreamConfig();
      if (config) {
        setServerUrl(config.server_url);
        setStreamKey(config.stream_key);
        setPresetIndex(config.preset_index ?? null);
        setHasConfig(true);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  });

  const handleSave = async () => {
    setSaving(true);
    try {
      await commands.setStreamConfig({
        server_url: serverUrl(),
        stream_key: streamKey(),
        preset_index: presetIndex(),
      });
      setHasConfig(true);
      await commands.globalMessageDialog("Stream configuration saved");
    } catch (e) {
      console.error(e);
      await commands.globalMessageDialog("Failed to save stream configuration");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setSaving(true);
    try {
      await commands.deleteStreamConfig();
      reset();
      await commands.globalMessageDialog("Stream configuration removed");
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  const renderInput = (
    label: string,
    value: () => string,
    setter: (v: string) => void,
    type: "text" | "password" = "text"
  ) => (
    <div>
      <label class="text-sm text-gray-12">{label}</label>
      <input
        type={type}
        value={value()}
        onInput={(e: InputEvent & { currentTarget: HTMLInputElement }) =>
          setter(e.currentTarget.value)
        }
        class="px-3 py-2 w-full rounded-lg border border-gray-3 focus:outline-none focus:ring-2 focus:ring-blue-500"
        autocomplete="off"
      />
    </div>
  );

  return (
    <div class="flex flex-col h-full">
      <div class="overflow-y-auto flex-1">
        <div class="p-4 space-y-4">
          {loading() ? (
            <div class="flex justify-center items-center h-32">
              <div class="w-8 h-8 rounded-full border-b-2 border-gray-900 animate-spin"></div>
            </div>
          ) : (
            <div class="space-y-4">
              {renderInput("Server URL", serverUrl, setServerUrl)}
              {renderInput("Stream Key", streamKey, setStreamKey, "password")}
              <div>
                <label class="text-sm text-gray-12">Editor Preset</label>
                <select
                  value={presetIndex() ?? ""}
                  onChange={(e) =>
                    setPresetIndex(
                      e.currentTarget.value === "" ? null : +e.currentTarget.value
                    )
                  }
                  class="px-3 py-2 pr-10 w-full bg-white rounded-lg border border-gray-3 appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Default</option>
                  <For each={presets.query.data?.presets ?? []}>
                    {(p, i) => <option value={i()}>{p.name}</option>}
                  </For>
                </select>
              </div>
            </div>
          )}
        </div>
      </div>
      <div class="flex-shrink-0 p-4 border-t">
        <div class="flex justify-between items-center">
          <div class="flex gap-2">
            {hasConfig() && (
              <Button
                variant="destructive"
                onClick={handleDelete}
                disabled={saving() || loading()}
                class={saving() || loading() ? "opacity-50 cursor-not-allowed" : ""}
              >
                {saving() ? "Removing..." : "Remove Config"}
              </Button>
            )}
          </div>
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={saving() || loading()}
            class={saving() || loading() ? "opacity-50 cursor-not-allowed" : ""}
          >
            {saving() ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
