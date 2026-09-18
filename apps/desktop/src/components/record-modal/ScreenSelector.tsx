import { Component, For, createSignal, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

export interface DisplayInfo {
  id: string;
  name: string;
  is_primary: boolean;
}

export const ScreenSelector: Component<{ onSelect?: (display: DisplayInfo) => void }> = (props) => {
  const [displays, setDisplays] = createSignal<DisplayInfo[]>([]);
  const [selectedId, setSelectedId] = createSignal<string>("");

  onMount(async () => {
    try {
      const list = await invoke<DisplayInfo[]>("list_displays");
      setDisplays(list);
      const primary = list.find((d) => d.is_primary) || list[0];
      if (primary) {
        setSelectedId(primary.id);
        props.onSelect?.(primary);
      }
    } catch (err) {
      console.error("Failed to load displays:", err);
    }
  });

  return (
    <div class="screen-selector flex gap-2">
      <For each={displays()}>
        {(display) => (
          <button
            class={`px-3 py-1.5 rounded text-sm ${
              selectedId() === display.id ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-300"
            }`}
            onClick={() => {
              setSelectedId(display.id);
              props.onSelect?.(display);
            }}
          >
            {display.name} {display.is_primary ? "(Primary)" : ""}
          </button>
        )}
      </For>
    </div>
  );
};
